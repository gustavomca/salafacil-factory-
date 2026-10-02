import type { Page, Locator } from '@playwright/test';
import {test,expect,login,unique,futureInterval,findRoom,fillReservation,capture,type Room,type Reservation,type PageResult} from './support.js';

async function activate(locator:Locator,mobile:boolean) {
  if(mobile) await locator.tap(); else await locator.click();
}
async function loseOneIdentityResponse(page:Page) {
  const failures:{upstreamStatus:number;failure:string}[]=[];
  await page.route('**/api/session/me',async route=>{
    if(failures.length){await route.continue();return;}
    const response=await route.fetch();
    failures.push({upstreamStatus:response.status(),failure:'connectionfailed after actual GET'});
    await route.abort('connectionfailed');
  });
  return failures;
}
async function nativeFocusCycle(page:Page, successful=false) {
  const session=await page.context().newCDPSession(page);
  await session.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  await page.evaluate(()=>{
    const events:{type:string;trusted:boolean;focus:boolean}[]=[];
    (window as unknown as {qaModalEvents:typeof events}).qaModalEvents=events;
    for(const type of ['focus','blur'])window.addEventListener(type,e=>events.push({type:e.type,trusted:e.isTrusted,focus:document.hasFocus()}));
  });
  const other=await page.context().newPage();
  const otherSession=await page.context().newCDPSession(other);
  await otherSession.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  await other.setContent('<title>QA native focus target</title>');
  await other.bringToFront();
  await expect.poll(()=>page.evaluate(()=>document.hasFocus())).toBe(false);
  const revalidated=successful?page.waitForResponse(r=>r.url().endsWith('/api/session/me')):null;
  await page.bringToFront();
  if(revalidated){
    expect((await revalidated).status()).toBe(200);
    await expect(page.locator('.session-check')).toHaveCount(0);
  }else await expect(page.locator('.session-check [role=alert]')).toBeVisible();
  const events=await page.evaluate(()=>(window as unknown as {qaModalEvents:{type:string;trusted:boolean;focus:boolean}[]}).qaModalEvents);
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({type:'blur',trusted:true,focus:false}),expect.objectContaining({type:'focus',trusted:true,focus:true})]));
  await other.close();
  return events;
}
const cases=[
  {kind:'CancelDialog',safe:'Manter reserva',submit:'Cancelar reserva'},
  {kind:'RoomEditor',safe:'Voltar',submit:'Criar sala'},
  {kind:'RoomTransition',safe:'Manter estado atual',submit:'Bloquear sala'},
] as const;
for(const scenario of cases) test(`C2 recuperação do modal ${scenario.kind} @injected`,async({page,adminApi,memberApi},info)=>{
  const mobile=info.project.name==='mobile';
  const room=await adminApi.createRoom(unique(`Modal ${scenario.kind} QA`));
  const draftName=unique('Rascunho modal QA');
  const reason=unique('Motivo preservado QA');
  let reservation:Reservation|undefined;
  if(scenario.kind==='CancelDialog') reservation=await memberApi.createReservation(room,unique('Cancelamento modal QA'),futureInterval(20));
  await login(page,'admin');
  const posts:{url:string;body:unknown}[]=[];
  page.on('request',request=>{
    const path=new URL(request.url()).pathname;
    if(request.method()==='POST'&&(path==='/api/rooms'||path.endsWith('/cancel')||path.endsWith('/block')))posts.push({url:request.url(),body:request.postDataJSON()});
  });
  if(scenario.kind==='CancelDialog')await page.goto(`/admin/reservations/${reservation!.id}`);
  else {
    await page.goto('/admin/rooms');
    await page.getByLabel('Buscar salas',{exact:true}).fill(room.name);
    await page.getByRole('button',{name:'Filtrar salas',exact:true}).click();
  }
  const dialog=page.getByRole('dialog');
  const open=async()=>{
    if(scenario.kind==='CancelDialog')await activate(page.getByRole('button',{name:'Cancelar reserva',exact:true}),mobile);
    else if(scenario.kind==='RoomEditor')await activate(page.getByRole('button',{name:'+ Nova sala',exact:true}),mobile);
    else await activate(page.getByRole('button',{name:`Bloquear ${room.name}`,exact:true}),mobile);
    await expect(dialog).toBeVisible();
    if(scenario.kind==='RoomEditor'){
      await dialog.getByLabel('Nome da sala',{exact:true}).fill(draftName);
      await dialog.getByLabel('Localização',{exact:true}).fill('Local preservado');
      await dialog.getByLabel('Capacidade',{exact:true}).fill('9');
      await dialog.getByRole('textbox',{name:'Descrição da sala',exact:true}).fill('Descrição preservada depois da falha');
    }else if(scenario.kind==='RoomTransition')await dialog.getByLabel('Motivo do bloqueio',{exact:true}).fill(reason);
  };
  const values=()=>dialog.locator('input,textarea,select').evaluateAll(nodes=>nodes.map(n=>({name:n.getAttribute('name'),value:(n as HTMLInputElement).value})));
  const assertUnchanged=async()=>{
    expect(posts).toEqual([]);
    expect((await adminApi.get<Room>(`/rooms/${room.id}`)).status).toBe('active');
    if(reservation)expect((await memberApi.get<Reservation>(`/reservations/${reservation.id}`)).status).toBe('confirmed');
    expect((await adminApi.get<PageResult<Room>>(`/rooms?search=${encodeURIComponent(draftName)}`)).count).toBe(0);
  };
  info.annotations.push({type:'injection',description:'Each of two phases drops exactly one real GET /session/me response after upstream200, first on native focus then on submit. No mutation response is fabricated. Safe close/retry uses ordinary click or mobile tap without force or Escape.'});
  await open();
  const before=await values();
  const focusFailures=await loseOneIdentityResponse(page);
  const events=await nativeFocusCycle(page);
  expect(focusFailures).toEqual([{upstreamStatus:200,failure:'connectionfailed after actual GET'}]);
  await page.unrouteAll({behavior:'wait'});
  const modalState=await dialog.evaluate(element=>({nativeModal:element.matches(':modal'),ancestorInert:!!element.parentElement?.closest('[inert]'),dialogInert:(element as HTMLDialogElement).inert,activeElement:document.activeElement?.tagName}));
  expect(modalState.nativeModal).toBe(true);
  expect(modalState.ancestorInert).toBe(true);
  expect(modalState.dialogInert).toBe(false);
  expect(await values()).toEqual(before);
  await assertUnchanged();
  await capture(page,info,`${scenario.kind}-focus-error`,false);
  // Actionability is exercised by a real click/tap; no force and no Escape.
  await activate(dialog.getByRole('button',{name:scenario.safe,exact:true}),mobile);
  await expect(dialog).not.toBeVisible();
  const retry=page.locator('.session-check').getByRole('button',{name:'Verificar sessão novamente',exact:true});
  await expect(retry).toBeVisible();
  const retryResponse=page.waitForResponse(r=>r.url().endsWith('/api/session/me'));
  await activate(retry,mobile);
  expect((await retryResponse).status()).toBe(200);
  await expect(page.locator('.session-check')).toHaveCount(0);
  // Observe the product's recovery focus before any later action can repair it.
  const recoveredFocus=await page.evaluate(()=>({tag:document.activeElement?.tagName,text:document.activeElement?.textContent?.trim(),connected:document.activeElement?.isConnected,body:document.activeElement===document.body}));
  await info.attach('c3-modal-recovery-focus',{body:JSON.stringify({scenario:scenario.kind,mobile,recoveredFocus,expected:'page h1'},null,2),contentType:'application/json'});
  await capture(page,info,`${scenario.kind}-recovered-focus`,false);
  await expect(page.getByRole('heading',{level:1})).toBeFocused();
  await assertUnchanged();

  await open();
  const submittedDraft=await values();
  const submitFailures=await loseOneIdentityResponse(page);
  await activate(dialog.getByRole('button',{name:scenario.submit,exact:true}),mobile);
  await expect(dialog.getByRole('alert')).toContainText('Não foi possível conectar ao servidor');
  expect(submitFailures).toEqual([{upstreamStatus:200,failure:'connectionfailed after actual GET'}]);
  await page.unrouteAll({behavior:'wait'});
  expect(await values()).toEqual(submittedDraft);
  await assertUnchanged();
  await expect(dialog.getByRole('button',{name:scenario.safe,exact:true})).toBeEnabled();
  await expect(dialog.getByRole('button',{name:scenario.submit,exact:true})).toBeEnabled();
  await capture(page,info,`${scenario.kind}-submit-error`,false);
  const committed=page.waitForResponse(r=>r.request().method()==='POST'&&(new URL(r.url()).pathname==='/api/rooms'||r.url().endsWith('/cancel')||r.url().endsWith('/block')));
  await activate(dialog.getByRole('button',{name:scenario.submit,exact:true}),mobile);
  expect((await committed).status()).toBe(scenario.kind==='RoomEditor'?201:200);
  await expect(dialog).not.toBeVisible();
  expect(posts).toHaveLength(1);
  if(reservation)expect((await memberApi.get<Reservation>(`/reservations/${reservation.id}`)).status).toBe('cancelled');
  if(scenario.kind==='RoomTransition')expect((await adminApi.get<Room>(`/rooms/${room.id}`)).status).toBe('blocked');
  if(scenario.kind==='RoomEditor')expect((await adminApi.get<PageResult<Room>>(`/rooms?search=${encodeURIComponent(draftName)}`)).count).toBe(1);
  await info.attach('modal-recovery-real-evidence',{body:JSON.stringify({scenario:scenario.kind,mobile,events,modalState,focusFailures,submitFailures,before,submittedDraft,posts,forcedActions:false,escapeUsed:false},null,2),contentType:'application/json'});
});


test('C3 recuperação inline devolve foco ao campo e mantém sequência de teclado @injected',async({page,adminApi},info)=>{
  info.annotations.push({type:'injection',description:'Exactly one genuine GET /session/me200 response is dropped after native focus, then the visible recovery button is reached by Tab and activated by Enter. No synthetic focus, forced click, fabricated identity or business mutation.'});
  const room=await adminApi.createRoom(unique('Foco inline QA'));
  const title=unique('Rascunho inline preservado');
  await login(page,'member');
  await findRoom(page,room,futureInterval(22));
  await fillReservation(page,title);
  const participants=page.getByLabel('Participantes',{exact:true});
  await participants.fill('5');
  // fill leaves this real control focused; all focus assertions after recovery observe only.
  await expect(participants).toBeFocused();
  const posts:string[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/reservations')posts.push(request.postData()??'');});
  const failures=await loseOneIdentityResponse(page);
  const events=await nativeFocusCycle(page);
  expect(failures).toEqual([{upstreamStatus:200,failure:'connectionfailed after actual GET'}]);
  await page.unrouteAll({behavior:'wait'});
  const panel=page.locator('.session-check');
  await expect(panel.getByRole('alert')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button',{name:'Verificar sessão novamente',exact:true})).toBeFocused();
  const recovery=page.waitForResponse(r=>r.url().endsWith('/api/session/me'));
  await page.keyboard.press('Enter');
  expect((await recovery).status()).toBe(200);
  await expect(panel).toHaveCount(0);
  const recoveredFocus=await page.evaluate(()=>({tag:document.activeElement?.tagName,body:document.activeElement===document.body,connected:document.activeElement?.isConnected,value:(document.activeElement as HTMLInputElement)?.value}));
  await info.attach('c3-inline-recovery-focus',{body:JSON.stringify({mobile:info.project.name==='mobile',events,failures,recoveredFocus,posts,expected:'Participantes'},null,2),contentType:'application/json'});
  await capture(page,info,'inline-recovered-focus',false);
  await expect(participants).toBeFocused();
  await expect(participants).toHaveValue('5');
  await expect(page.getByLabel('Título da reunião',{exact:true})).toHaveValue(title);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox',{name:'Descrição (opcional)',exact:true})).toBeFocused();
  expect(posts).toEqual([]);

  // Click/tap the empty header corner outside focusable main, then read farther down.
  // These are setup gestures; after the baseline no test action focuses or scrolls.
  const header=page.getByRole('banner');
  if(info.project.name==='mobile')await header.tap({position:{x:1,y:1}});
  else await header.click({position:{x:1,y:1}});
  // Install before the gesture; a delayed scrollend from header auto-scroll at0
  // must not be mistaken for completion of PageDown's reading-position scroll.
  await page.evaluate(()=>{
    const positions:number[]=[];
    const settled=new Promise<number[]>(resolve=>{
      const ended=()=>{
        positions.push(window.scrollY);
        if(window.scrollY<=100)return;
        window.removeEventListener('scrollend',ended);
        resolve(positions);
      };
      window.addEventListener('scrollend',ended);
    });
    (window as unknown as {qaScrollPreparation:Promise<number[]>}).qaScrollPreparation=settled;
  });
  await page.keyboard.press('PageDown');
  const preparationScrollEnds=await page.evaluate(()=>(window as unknown as {qaScrollPreparation:Promise<number[]>}).qaScrollPreparation);
  const passiveBefore=await page.evaluate(()=>({tag:document.activeElement?.tagName,body:document.activeElement===document.body,scrollY:window.scrollY}));
  await info.attach('c4-passive-body-before',{body:JSON.stringify({...passiveBefore,preparationScrollEnds}),contentType:'application/json'});
  expect(passiveBefore.body).toBe(true);
  expect(passiveBefore.scrollY).toBeGreaterThan(100);
  await page.evaluate(()=>{
    const samples:number[]=[];
    (window as unknown as {qaPassiveScroll:number[]}).qaPassiveScroll=samples;
    window.addEventListener('scroll',()=>samples.push(window.scrollY));
  });
  // This phase has no transport injection: the original GET response reaches the app.
  const passiveEvents=await nativeFocusCycle(page,true);
  await page.waitForLoadState('networkidle');
  const passiveAfter=await page.evaluate(()=>({tag:document.activeElement?.tagName,body:document.activeElement===document.body,scrollY:window.scrollY,scrollEvents:(window as unknown as {qaPassiveScroll:number[]}).qaPassiveScroll}));
  await info.attach('c4-passive-body-scroll',{body:JSON.stringify({mobile:info.project.name==='mobile',passiveBefore,passiveAfter,events:passiveEvents,identityGetStatus:200,transportInjected:false,posts},null,2),contentType:'application/json'});
  await capture(page,info,'passive-body-scroll',false);
  expect(passiveAfter.body).toBe(true);
  expect(passiveAfter.scrollY).toBe(passiveBefore.scrollY);
  expect(posts).toEqual([]);
});
