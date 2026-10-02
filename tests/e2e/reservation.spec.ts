import { test, expect, login, unique, futureInterval, findRoom, fillReservation, assertA11y, assertNoOverflow, capture, assertSuccessFocus, type PageResult, type Reservation } from './support.js';

test('jornada real: login → disponibilidade → criar → consultar → cancelar → histórico', async ({ page, adminApi, memberApi }, info) => {
  const room = await adminApi.createRoom(unique('Ciclo QA'));
  const title = unique('Reunião de equipe');
  await login(page);
  await expect(page.getByRole('main')).toContainText(/agenda|próxim|reservas/i);
  await capture(page, info, 'dashboard');
  await findRoom(page, room);
  await fillReservation(page, title);
  await assertNoOverflow(page);
  await assertA11y(page, info, 'reservation-form');
  await capture(page, info, 'reservation-form');
  await page.getByRole('complementary', { name: 'Nova reserva', exact: true }).screenshot({ path: info.outputPath('reservation-form-detail.png') });
  const createdResponse = page.waitForResponse(response => response.url().endsWith('/api/reservations') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /^Confirmar reserva$/i }).click();
  const response = await createdResponse;
  expect(response.status()).toBe(201);
  const created = await response.json() as Reservation;
  expect(created.title).toBe(title);
  expect(created.room.id).toBe(room.id);
  await assertSuccessFocus(page, /Reserva confirmada/i);
  await capture(page, info, 'reservation-success-focus', false);
  await page.goto('/reservations');
  // Other scenarios preserve their cancelled history; scope our own room via UI.
  await page.getByLabel('ID da sala', { exact: true }).fill(String(room.id));
  await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
  const cancel = page.getByRole('button', { name: `Cancelar ${title}`, exact: true });
  await expect(cancel).toBeVisible();
  await cancel.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(title);
  await expect(dialog).toContainText(room.name);
  await expect(dialog.getByRole('button', { name: /^Manter reserva$/i })).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await assertA11y(page, info, 'cancel-dialog');
  await capture(page, info, 'cancel-dialog', false);
  const cancelledResponse = page.waitForResponse(r => r.url().endsWith(`/api/reservations/${created.id}/cancel`));
  const refreshedUpcoming = page.waitForResponse(r => {
    const url = new URL(r.url());
    return r.request().method() === 'GET' && url.pathname === '/api/reservations'
      && url.searchParams.get('status') === 'confirmed'
      && url.searchParams.get('room_id') === String(room.id);
  });
  await dialog.getByRole('button', { name: /^Cancelar reserva$/i }).click();
  expect((await cancelledResponse).status()).toBe(200);
  await assertSuccessFocus(page, /Reserva cancelada/);
  const current = await refreshedUpcoming;
  expect(current.status()).toBe(200);
  const upcoming = await current.json() as PageResult<Reservation>;
  expect(upcoming.count).toBe(0);
  expect(upcoming.results).toEqual([]);
  await expect(page.getByRole('link', { name: title, exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Paginação', exact: true })).toContainText('0 registros');
  await assertSuccessFocus(page, /Reserva cancelada/);
  await capture(page, info, 'cancel-success-focus', false);
  await page.getByRole('button', { name: /^Canceladas$/i }).click();
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('main')).toContainText(/cancelada/i);
  const persisted = await memberApi.get<Reservation>(`/reservations/${created.id}`);
  expect(persisted.status).toBe('cancelled');
  expect(persisted.cancelled_at).toBeTruthy();
  await page.reload();
  await expect(page.getByLabel('ID da sala', { exact: true })).toHaveValue(String(room.id));
  await page.getByRole('button', { name: /^Canceladas$/i }).click();
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
  await assertNoOverflow(page);
  await capture(page, info, 'cancelled-history');
});

test('disputa real 409 preserva campos e permite atualizar disponibilidade', async ({ page, adminApi, memberApi }, info) => {
  const room = await adminApi.createRoom(unique('Conflito QA'));
  const interval = futureInterval(3);
  const title = unique('Formulário preservado');
  await login(page);
  await findRoom(page, room, interval);
  await fillReservation(page, title, 'Descrição deve sobreviver ao conflito', '4');
  const winner = await adminApi.createReservation(room, unique('Vencedora QA'), interval);
  const rejected = page.waitForResponse(r => r.url().endsWith('/api/reservations') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^Confirmar reserva$/i }).click();
  expect((await rejected).status()).toBe(409);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel(/^Título da reunião$/i)).toHaveValue(title);
  await expect(page.getByRole('textbox', { name: /^Descrição \(opcional\)$/i })).toHaveValue('Descrição deve sobreviver ao conflito');
  await expect(page.getByLabel(/^Participantes$/i)).toHaveValue('4');
  await expect(page.getByRole('button', { name: /Atualizar (consulta|disponibilidade)/i })).toBeVisible();
  const refreshed = page.waitForResponse(r => r.url().includes('/api/availability?'));
  await page.getByRole('button', { name: /Atualizar (consulta|disponibilidade)/i }).click();
  expect((await refreshed).status()).toBe(200);
  await expect(page.getByRole('button', { name: `Reservar ${room.name}`, exact: true })).toHaveCount(0);
  await expect(page.getByLabel(/^Título da reunião$/i)).toHaveValue(title);
  await expect(page.getByRole('textbox', { name: /^Descrição \(opcional\)$/i })).toHaveValue('Descrição deve sobreviver ao conflito');
  await expect(page.getByLabel(/^Participantes$/i)).toHaveValue('4');
  await capture(page, info, 'conflict-fields-retained');
  await assertNoOverflow(page);
  const mine = await memberApi.get<PageResult<Reservation>>(`/reservations?room_id=${room.id}`);
  expect(mine.results.some(r => r.title === title)).toBe(false);
  await adminApi.write(`/reservations/${winner.id}/cancel`);
});

test('resultado incerto após commit real não reenvia POST automaticamente @injected', async ({ page, adminApi, memberApi }, info) => {
  const room = await adminApi.createRoom(unique('Transporte QA'));
  const title = unique('Commit com resposta perdida');
  await login(page);
  // Explicit UI-state injection: pause one real GET; then continue it unchanged.
  let releaseLoading!: () => void;
  let markLoadingRequest!: () => void;
  const releaseGate = new Promise<void>(resolve => { releaseLoading = resolve; });
  const loadingRequest = new Promise<void>(resolve => { markLoadingRequest = resolve; });
  const loadingPattern = '**/api/rooms?*';
  await page.route(loadingPattern, async route => {
    if (route.request().method() === 'GET') {
      markLoadingRequest();
      await releaseGate;
    }
    await route.continue();
  });
  info.annotations.push({ type: 'injection', description: 'GET /api/rooms paused until the loading screenshot, then continued with its real response; no response payload fabricated.' });
  try {
    await page.goto('/rooms');
    await loadingRequest;
    const loading = page.getByRole('main').getByText('Consultando salas…', { exact: true });
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('aria-busy', 'true');
    await assertNoOverflow(page);
    await capture(page, info, 'injected-real-get-loading', false);
    const continued = page.waitForResponse(r => r.request().method() === 'GET' && r.url().includes('/api/rooms?'));
    releaseLoading();
    expect((await continued).status()).toBe(200);
    await expect(loading).not.toBeVisible();
  } finally {
    releaseLoading();
    await page.unroute(loadingPattern);
  }
  await findRoom(page, room, futureInterval(4));
  await fillReservation(page, title);
  let writes = 0;
  await page.route('**/api/reservations', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    writes++;
    const committed = await route.fetch();
    expect(committed.status()).toBe(201);
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: /^Confirmar reserva$/i }).click();
  await expect(page.getByRole('alert')).toContainText(/incert|não foi possível confirmar o resultado/i);
  await expect(page.getByRole('button', { name: /^Confirmar reserva$/i })).toBeDisabled();
  await expect(page.getByLabel(/^Título da reunião$/i)).toHaveValue(title);
  await capture(page, info, 'injected-uncertain-result');
  const mine = await memberApi.get<PageResult<Reservation>>(`/reservations?room_id=${room.id}`);
  expect(mine.results.filter(r => r.title === title)).toHaveLength(1);
  await page.getByRole('link', { name: /Consultar minhas reservas/i }).click();
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
  expect(writes).toBe(1);
  await memberApi.write(`/reservations/${mine.results.find(r => r.title === title)!.id}/cancel`);
});
