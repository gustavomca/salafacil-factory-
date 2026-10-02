import type { Page } from '@playwright/test';
import { test, expect, accounts, login, unique, futureInterval, localInput, findRoom, fillReservation, capture, assertNoOverflow, type Room, type Reservation, type PageResult } from './support.js';

const unavailable = { error: { code: 'SERVICE_UNAVAILABLE', message: 'Serviço temporariamente indisponível.', details: {} } };

/** The upstream mutation really commits; only its received response is replaced. */
async function commitThen503(page: Page, pattern: string, status: number) {
  const commits: unknown[] = [];
  await page.route(pattern, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const actual = await route.fetch();
    expect(actual.status()).toBe(status);
    commits.push(await actual.json());
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(unavailable) });
  });
  return commits;
}

test('503 JSON após commits reais bloqueia duplicação e consulta reserva, sala e cancelamento administrativo @injected', async ({ page, adminApi, memberApi }, info) => {
  info.annotations.push({ type: 'injection', description: 'Real POSTs commit before their responses are replaced by 503 JSON SERVICE_UNAVAILABLE, matching the gateway envelope; no mutation or persisted record is mocked.' });
  const room = await adminApi.createRoom(unique('503 QA'));
  const title = unique('Reserva 503 confirmada no servidor');
  await login(page, 'admin');
  await findRoom(page, room, futureInterval(8));
  await fillReservation(page, title);
  const reservationCommits = await commitThen503(page, '**/api/reservations', 201);
  await page.getByRole('button', { name: 'Confirmar reserva', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/incert|confirmar o resultado/i);
  await expect(page.getByRole('button', { name: 'Confirmar reserva', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Título da reunião', { exact: true })).toHaveValue(title);
  await capture(page, info, '503-reservation-uncertain');
  const mine = await adminApi.get<PageResult<Reservation>>(`/reservations?room_id=${room.id}`);
  expect(mine.results.filter(item => item.title === title)).toHaveLength(1);
  await page.getByRole('link', { name: /Consultar minhas reservas/i }).click();
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
  expect(reservationCommits).toHaveLength(1);
  await page.unroute('**/api/reservations');

  const name = unique('Sala 503 criada no servidor');
  await page.goto('/admin/rooms');
  await page.getByRole('button', { name: '+ Nova sala', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Nova sala', exact: true });
  await editor.getByLabel('Nome da sala', { exact: true }).fill(name);
  await editor.getByLabel('Localização', { exact: true }).fill('QA retorno perdido');
  await editor.getByLabel('Capacidade', { exact: true }).fill('8');
  const roomCommits = await commitThen503(page, '**/api/rooms', 201);
  await editor.getByRole('button', { name: 'Criar sala', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText(/incert|confirmar o resultado/i);
  await expect(editor.getByRole('button', { name: 'Criar sala', exact: true })).toBeDisabled();
  await expect(editor.getByLabel('Nome da sala', { exact: true })).toHaveValue(name);
  await capture(page, info, '503-room-uncertain', false);
  const rooms = await adminApi.get<PageResult<Room>>(`/rooms?search=${encodeURIComponent(name)}`);
  expect(rooms.results.filter(item => item.name === name)).toHaveLength(1);
  await editor.getByRole('button', { name: 'Consultar salas antes de reenviar', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page).toHaveURL(/\/admin\/rooms/);
  await page.getByLabel('Buscar salas', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Filtrar salas', exact: true }).click();
  await expect(page.getByRole('button', { name: `Editar ${name}`, exact: true })).toBeVisible();
  expect(roomCommits).toHaveLength(1);
  await page.unroute('**/api/rooms');

  const other = await memberApi.createReservation(room, unique('Membro cancelado pelo admin'), futureInterval(9));
  await page.goto(`/admin/reservations/${other.id}`);
  await expect(page.getByRole('main')).toContainText(accounts.member.email);
  await page.getByRole('button', { name: 'Cancelar reserva', exact: true }).click();
  const cancelCommits = await commitThen503(page, `**/api/reservations/${other.id}/cancel`, 200);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Cancelar reserva', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(/incert|confirmar o resultado/i);
  await expect(dialog.getByRole('button', { name: 'Cancelar reserva', exact: true })).toBeDisabled();
  const review = dialog.getByRole('link', { name: /Consultar/i });
  await expect(review).toHaveAttribute('href', new RegExp(`/admin/reservations(?:/${other.id})?`));
  await capture(page, info, '503-admin-other-owner-cancel', false);
  await review.click();
  await expect(page).toHaveURL(/\/admin\/reservations/);
  await expect(page.getByRole('main')).toContainText(/cancelada/i);
  expect((await memberApi.get<Reservation>(`/reservations/${other.id}`)).status).toBe('cancelled');
  expect(cancelCommits).toHaveLength(1);
  await assertNoOverflow(page);
});

/** Real server logout without focus changes; C002 separately covers two tabs. */
async function expireSessionWithoutFocus(page: Page) {
  const csrf = await page.request.get('/api/session/csrf');
  expect(csrf.status()).toBe(200);
  const token = await csrf.json() as {csrf_token:string};
  const logout = await page.request.post('/api/session/logout', {
    data:{}, headers:{'X-CSRFToken':token.csrf_token,Origin:new URL(page.url()).origin},
  });
  expect(logout.status()).toBe(204);
  // This authenticated endpoint proves expiration independently of the UI guard.
  const expired = await page.request.get('/api/reservations');
  expect(expired.status()).toBe(401);
}
async function reloginInPlace(page: Page) {
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('E-mail', { exact: true }).fill(accounts.member.email);
  await page.getByLabel('Senha', { exact: true }).fill(accounts.member.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
}

test('sessão expirada no servidor restaura rascunho só para a mesma conta e URL', async ({ page, adminApi, memberApi }, info) => {
  const room = await adminApi.createRoom(unique('Rascunho QA'));
  const title = unique('Rascunho privado do membro');
  const description = unique('Descrição longa a preservar');
  const interval = futureInterval(10);
  await login(page);
  await findRoom(page, room, interval);
  await fillReservation(page, title, description, '5');
  const draftUrl = page.url();
  const posts: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && ['/api/reservations','/api/rooms'].includes(new URL(request.url()).pathname)) posts.push(request.url());
  });
  await expireSessionWithoutFocus(page);
  const expired = page.waitForResponse(r => r.url().endsWith('/api/session/me'));
  await page.getByRole('button', { name: 'Confirmar reserva', exact: true }).click();
  const identity = await expired;
  expect(identity.status()).toBe(200);
  expect((await identity.json()).user).toBeNull();
  expect(posts).toEqual([]);
  await reloginInPlace(page);
  await expect(page).toHaveURL(draftUrl);
  await expect(page.getByLabel('Título da reunião', { exact: true })).toHaveValue(title);
  await expect(page.getByRole('textbox', { name: 'Descrição (opcional)', exact: true })).toHaveValue(description);
  await expect(page.getByLabel('Participantes', { exact: true })).toHaveValue('5');
  await expect(page.getByLabel('Início da reserva', { exact: true })).toHaveValue(localInput(interval.start));
  await expect(page.getByLabel('Término da reserva', { exact: true })).toHaveValue(localInput(interval.end));
  await capture(page, info, 'expired-session-draft-restored');
  expect((await memberApi.get<PageResult<Reservation>>(`/reservations?room_id=${room.id}`)).count).toBe(0);
  // Expire again, then deliberately use a different authenticated owner.
  await expireSessionWithoutFocus(page);
  await page.getByRole('button', { name: 'Confirmar reserva', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('E-mail', { exact: true }).fill(accounts.admin.email);
  await page.getByLabel('Senha', { exact: true }).fill(accounts.admin.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByLabel('Título da reunião', { exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Descrição (opcional)', exact: true })).toHaveValue('');
  const state = await page.context().storageState();
  expect(JSON.stringify(state.origins)).not.toContain(title);

  const roomName = unique('Rascunho administrativo');
  await page.goto('/admin/rooms');
  await page.getByRole('button', {name:'+ Nova sala',exact:true}).click();
  const editor = page.getByRole('dialog', {name:'Nova sala',exact:true});
  await editor.getByLabel('Nome da sala',{exact:true}).fill(roomName);
  await editor.getByLabel('Localização',{exact:true}).fill('Local preservado');
  await editor.getByLabel('Capacidade',{exact:true}).fill('17');
  await editor.getByRole('textbox',{name:'Descrição da sala',exact:true}).fill('Rascunho confidencial administrativo');
  await expireSessionWithoutFocus(page);
  const expiredRoom = page.waitForResponse(r => r.url().endsWith('/api/session/me'));
  await editor.getByRole('button',{name:'Criar sala',exact:true}).click();
  const editorIdentity = await expiredRoom;
  expect(editorIdentity.status()).toBe(200);
  expect((await editorIdentity.json()).user).toBeNull();
  expect(posts).toEqual([]);
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('E-mail',{exact:true}).fill(accounts.admin.email);
  await page.getByLabel('Senha',{exact:true}).fill(accounts.admin.password);
  await page.getByRole('button',{name:'Entrar',exact:true}).click();
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Nome da sala',{exact:true})).toHaveValue(roomName);
  await expect(editor.getByLabel('Localização',{exact:true})).toHaveValue('Local preservado');
  await expect(editor.getByLabel('Capacidade',{exact:true})).toHaveValue('17');
  await expect(editor.getByRole('textbox',{name:'Descrição da sala',exact:true})).toHaveValue('Rascunho confidencial administrativo');
  expect((await adminApi.get<PageResult<Room>>(`/rooms?search=${encodeURIComponent(roomName)}`)).count).toBe(0);
  await info.attach('real-expiration-without-business-post',{body:JSON.stringify({draftUrl,posts,expiration:'Real CSRF-protected logout returned 204; authenticated GET returned 401; mutation guard observed /session/me user=null before sending any business POST.'},null,2),contentType:'application/json'});
  await capture(page, info, 'expired-admin-editor-restored', false);
});
