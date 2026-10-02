import { test, expect, accounts, login, unique, futureInterval, localInput, findRoom, chooseAvailableRoom, fillReservation, capture, assertSuccessFocus, type Reservation, type PageResult } from './support.js';

test('C001 nova escolha SPA da mesma sala prevalece sobre o rascunho do intervalo anterior', async ({ page, adminApi, memberApi }, info) => {
  const room = await adminApi.createRoom(unique('Intenção SPA QA'));
  const intervalA = futureInterval(16);
  const intervalB = futureInterval(17);
  const titleA = unique('Intenção antiga não deve ser gravada');
  const titleB = unique('Intenção atual confirmada');
  await login(page);
  await findRoom(page, room, intervalA);
  await fillReservation(page, titleA, 'Texto privado da intenção anterior', '3');
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const documents: string[] = [];
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url());
  });
  // This Link must preserve the live SPA memory that exposed O4-C-001.
  await page.getByRole('navigation', {name:'Principal',exact:true}).getByRole('link', {name:'Salas e horários',exact:true}).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await chooseAvailableRoom(page, room, intervalB, '6');
  await expect(page).toHaveURL(/\/reservations\/new\?/);
  expect(new URL(page.url()).searchParams.get('room_id')).toBe(String(room.id));
  expect(new URL(page.url()).searchParams.get('start')).toBe(localInput(intervalB.start));
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  expect(documents, 'the reproduction must not erase in-memory drafts with a full navigation').toEqual([]);
  await expect(page.getByLabel('Início da reserva', {exact:true})).toHaveValue(localInput(intervalB.start));
  await expect(page.getByLabel('Término da reserva', {exact:true})).toHaveValue(localInput(intervalB.end));
  await expect(page.getByLabel('Participantes', {exact:true})).toHaveValue('6');
  await expect(page.getByLabel('Título da reunião', {exact:true})).toHaveValue('');
  await expect(page.getByRole('textbox', {name:'Descrição (opcional)',exact:true})).toHaveValue('');
  await fillReservation(page, titleB, 'Texto da nova intenção', '6');
  await capture(page, info, 'c001-spa-new-intent');
  const committed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/reservations' && r.request().method() === 'POST');
  await page.getByRole('button', {name:'Confirmar reserva',exact:true}).click();
  const response = await committed;
  expect(response.status()).toBe(201);
  const payload = response.request().postDataJSON() as {room_id:number;starts_at:string;ends_at:string;participants:number;title:string};
  expect(payload.room_id).toBe(room.id);
  expect(Date.parse(payload.starts_at)).toBe(Date.parse(intervalB.start));
  expect(Date.parse(payload.ends_at)).toBe(Date.parse(intervalB.end));
  expect(payload.participants).toBe(6);
  expect(payload.title).toBe(titleB);
  await assertSuccessFocus(page, /Reserva confirmada/);
  const created = await response.json() as Reservation;
  const stored = await memberApi.get<Reservation>(`/reservations/${created.id}`);
  expect(Date.parse(stored.starts_at)).toBe(Date.parse(intervalB.start));
  expect(Date.parse(stored.ends_at)).toBe(Date.parse(intervalB.end));
  const own = await memberApi.get<PageResult<Reservation>>(`/reservations?room_id=${room.id}`);
  expect(own.count).toBe(1);
  expect(own.results[0].title).toBe(titleB);
  await info.attach('c001-real-payload-and-persistence', {body:JSON.stringify({room_id:room.id,intervalA,intervalB,payload,stored,documentNavigations:documents},null,2),contentType:'application/json'});
});

test('C002 foco entre abas bloqueia mutação enquanto verifica identidade e descarta rascunho alheio @injected', async ({ page, adminApi, memberApi }, info) => {
  const room = await adminApi.createRoom(unique('Identidade entre abas QA'));
  const interval = futureInterval(18);
  const memberTitle = unique('Rascunho exclusivo do membro');
  const memberDescription = unique('Descrição exclusiva do membro');
  await login(page);
  await findRoom(page, room, interval);
  await fillReservation(page, memberTitle, memberDescription, '4');
  const draftUrl = page.url();
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const posts: unknown[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/reservations' && request.method() === 'POST') posts.push(request.postDataJSON());
  });
  // Playwright otherwise forces every page to appear focused, even when headed.
  // The Xvfb runner supplies real window focus; do not synthesize DOM events.
  const focusSessionA = await page.context().newCDPSession(page);
  await focusSessionA.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  await page.evaluate(() => {
    const events: {type:string;trusted:boolean;focused:boolean;visible:string}[] = [];
    (window as unknown as {qaNativeFocus:typeof events}).qaNativeFocus = events;
    for (const type of ['focus','blur']) window.addEventListener(type,event => events.push({type:event.type,trusted:event.isTrusted,focused:document.hasFocus(),visible:document.visibilityState}));
  });
  const tabB = await page.context().newPage();
  const focusSessionB = await page.context().newCDPSession(tabB);
  await focusSessionB.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  try {
    await tabB.goto('/dashboard');
    await tabB.bringToFront();
    await tabB.getByRole('button', {name:'Sair da conta',exact:true}).click();
    await expect(tabB).toHaveURL(/\/login/);
    await tabB.getByLabel('E-mail',{exact:true}).fill(accounts.admin.email);
    await tabB.getByLabel('Senha',{exact:true}).fill(accounts.admin.password);
    await tabB.getByRole('button',{name:'Entrar',exact:true}).click();
    await expect(tabB).toHaveURL(/\/dashboard$/);
    await tabB.waitForLoadState('networkidle');
    await expect.poll(() => page.evaluate(() => document.hasFocus()),{message:'Headed tab A must actually lose focus while tab B is active'}).toBe(false);

    let release!: () => void;
    let observed = false;
    const gate = new Promise<void>(resolve => {release=resolve;});
    await page.route('**/api/session/me', async route => {
      observed = true;
      await gate;
      await route.continue();
    });
    info.annotations.push({type:'injection',description:'Only the real GET /session/me on tab A is paused during focus revalidation, then continued unchanged. Headed Chromium/Xvfb uses native focus with Playwright focus emulation disabled through CDP; trusted blur/focus events are asserted, never dispatched by the test. Logout/login and all domain writes use the real server; no user payload or cookie is fabricated.'});
    try {
      const identityResponse = page.waitForResponse(r => r.url().endsWith('/api/session/me'));
      await page.bringToFront();
      await expect.poll(() => observed, {message:'Real tab focus must trigger identity revalidation'}).toBe(true);
      const focusEvents = await page.evaluate(() => (window as unknown as {qaNativeFocus:{type:string;trusted:boolean;focused:boolean;visible:string}[]}).qaNativeFocus);
      expect(focusEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({type:'blur',trusted:true,focused:false}),
        expect.objectContaining({type:'focus',trusted:true,focused:true}),
      ]));
      await info.attach('c002-native-focus-events',{body:JSON.stringify({headed:true,playwrightFocusEmulation:false,events:focusEvents},null,2),contentType:'application/json'});
      await expect(page.locator('.session-check').getByText('Verificando sua sessão…',{exact:true})).toBeVisible();
      await expect(page.getByRole('status',{name:'Atualizações da página',exact:true})).toHaveText('Verificando sua sessão…');
      const confirm = page.getByRole('button',{name:'Confirmar reserva',exact:true});
      await expect.poll(async () => (await confirm.count()) === 0 || await confirm.evaluate(element => Boolean(element.closest('[inert]')) || (element as HTMLButtonElement).disabled), {message:'Tab A must block submission while its current owner is unknown'}).toBe(true);
      await page.keyboard.press('Enter');
      expect(posts).toEqual([]);
      await capture(page, info, 'c002-identity-check-pending', false);
      release();
      const response = await identityResponse;
      expect(response.status()).toBe(200);
      const identity = await response.json() as {user:{id:number;email:string;role:string}};
      expect(identity.user.email).toBe(accounts.admin.email);
      await info.attach('c002-real-resolved-identity',{body:JSON.stringify(identity,null,2),contentType:'application/json'});
    } finally {
      release();
      await page.unrouteAll({behavior:'wait'});
    }
    // Contract: ownership change is explicit, before any new business mutation.
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('main')).toContainText('A conta foi alterada em outra aba. Entre novamente para continuar. Os rascunhos da conta anterior foram descartados.');
    expect(posts).toEqual([]);
    expect((await adminApi.get<PageResult<Reservation>>(`/reservations?scope=all&room_id=${room.id}`)).count).toBe(0);
    await capture(page, info, 'c002-identity-change-detected', false);
    // Explicit login follows the product's account-change notice. No page.goto
    // or reload may erase tab A's old in-memory draft before the assertions.
    await page.getByLabel('E-mail',{exact:true}).fill(accounts.admin.email);
    await page.getByLabel('Senha',{exact:true}).fill(accounts.admin.password);
    await page.getByRole('button',{name:'Entrar',exact:true}).click();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    await expect(page).toHaveURL(draftUrl);
    await expect(page.getByLabel('Título da reunião',{exact:true})).toHaveValue('');
    await expect(page.getByRole('textbox',{name:'Descrição (opcional)',exact:true})).toHaveValue('');
    await expect(page.getByRole('link',{name:'Gerenciar salas',exact:true})).toBeVisible();
    const adminTitle = unique('Escolha explícita sob admin');
    await fillReservation(page, adminTitle, 'Novo texto da conta atual', '2');
    const committed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/reservations' && r.request().method() === 'POST');
    await page.getByRole('button',{name:'Confirmar reserva',exact:true}).click();
    const response = await committed;
    expect(response.status()).toBe(201);
    await assertSuccessFocus(page,/Reserva confirmada/);
    const created = await response.json() as Reservation;
    const attributed = await adminApi.get<Reservation & {user:{id:number;email:string}}>(`/reservations/${created.id}?scope=all`);
    expect(attributed.user.email).toBe(accounts.admin.email);
    expect(attributed.title).toBe(adminTitle);
    expect(JSON.stringify(attributed)).not.toContain(memberTitle);
    expect(JSON.stringify(attributed)).not.toContain(memberDescription);
    expect(posts).toHaveLength(1);
    await memberApi.get(`/reservations/${created.id}`,403);
    const own = await memberApi.get<PageResult<Reservation>>(`/reservations?room_id=${room.id}`);
    expect(own.count).toBe(0);
    await info.attach('c002-actual-attribution',{body:JSON.stringify({posts,attributed,memberResults:own},null,2),contentType:'application/json'});
  } finally { await tabB.close(); }
});
