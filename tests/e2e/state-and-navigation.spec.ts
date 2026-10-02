import { test, expect, login, unique, futureInterval, localInput, capture, assertNoOverflow, type Room, type Reservation, type PageResult } from './support.js';

test('filtros inválidos permitem edição por teclado; voltar/avançar e reload restauram a consulta', async ({ page, adminApi, memberApi }, info) => {
  const firstRoom = await adminApi.createRoom(unique('Histórico URL A'));
  const secondRoom = await adminApi.createRoom(unique('Histórico URL B'));
  const interval = futureInterval(12);
  const first = await memberApi.createReservation(firstRoom, unique('Reserva URL A'), interval);
  const second = await memberApi.createReservation(secondRoom, unique('Reserva URL B'), interval);
  await login(page, 'admin');
  await page.goto('/admin/reservations');
  await page.getByLabel('Período: a partir de', { exact: true }).fill(localInput(interval.end));
  await page.getByLabel('Período: até', { exact: true }).fill(localInput(interval.start));
  await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
  await expect(page.getByRole('alert')).toBeFocused();
  const id = page.getByLabel('ID da sala', { exact: true });
  await id.focus();
  for (const digit of String(firstRoom.id)) {
    await page.keyboard.type(digit);
    await expect(id).toBeFocused();
  }
  await expect(id).toHaveValue(String(firstRoom.id));
  await page.getByLabel('Período: a partir de', { exact: true }).fill(localInput(interval.start));
  await page.getByLabel('Período: até', { exact: true }).fill(localInput(interval.end));
  await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('link', { name: first.title, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: second.title, exact: true })).toHaveCount(0);
  const firstUrl = page.url();
  await id.fill(String(secondRoom.id));
  await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
  await expect(page.getByRole('link', { name: second.title, exact: true })).toBeVisible();
  const secondUrl = page.url();
  await page.goBack();
  await expect(page).toHaveURL(firstUrl);
  await expect(id).toHaveValue(String(firstRoom.id));
  await expect(page.getByRole('link', { name: first.title, exact: true })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(secondUrl);
  await expect(id).toHaveValue(String(secondRoom.id));
  await expect(page.getByRole('link', { name: second.title, exact: true })).toBeVisible();
  await page.reload();
  await expect(id).toHaveValue(String(secondRoom.id));
  await expect(page.getByLabel('Período: a partir de', { exact: true })).toHaveValue(localInput(interval.start));
  await capture(page, info, 'url-history-restored');

  await page.goto('/admin/audit');
  await page.getByLabel('Auditoria: a partir de', { exact: true }).fill(localInput(interval.end));
  await page.getByLabel('Auditoria: até', { exact: true }).fill(localInput(interval.start));
  await page.getByRole('button', { name: 'Filtrar eventos', exact: true }).click();
  await expect(page.getByRole('alert')).toBeFocused();
  const actor = page.getByLabel('ID do ator', { exact: true });
  await actor.focus();
  for (const digit of '123') {
    await page.keyboard.type(digit);
    await expect(actor).toBeFocused();
  }
  await expect(actor).toHaveValue('123');
  await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await assertNoOverflow(page);
});

test('estado concorrente administrativo reconcilia 409; URL direta de sala bloqueada impede confirmar', async ({ page, adminApi }, info) => {
  const room = await adminApi.createRoom(unique('Concorrência de estado QA'));
  await login(page, 'admin');
  await page.goto(`/admin/rooms?search=${encodeURIComponent(room.name)}`);
  await page.getByRole('button', { name: `Bloquear ${room.name}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Manter estado atual', exact: true })).toBeFocused();
  await dialog.getByRole('textbox', { name: 'Motivo do bloqueio', exact: true }).fill('Bloqueio que perdeu a disputa');
  await adminApi.write(`/rooms/${room.id}/deactivate`);
  const conflict = page.waitForResponse(r => r.url().endsWith(`/api/rooms/${room.id}/block`));
  await dialog.getByRole('button', { name: 'Bloquear sala', exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(dialog.getByRole('alert')).toContainText(/estado|inativ|sala/i);
  await expect(dialog.getByRole('alert')).not.toContainText(/intervalo.*ocupado/i);
  await capture(page, info, 'concurrent-room-state-409', false);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: `Reativar ${room.name}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Bloquear ${room.name}`, exact: true })).toHaveCount(0);
  expect((await adminApi.get<Room>(`/rooms/${room.id}`)).status).toBe('inactive');
  // Reapplying identical filters is a genuine refresh, including another actor's edit.
  await adminApi.write(`/rooms/${room.id}/reactivate`);
  const refreshed = page.waitForResponse(r => r.request().method() === 'GET' && r.url().includes('/api/rooms?'));
  await page.getByRole('button', { name: 'Filtrar salas', exact: true }).click();
  expect((await refreshed).status()).toBe(200);
  await expect(page.getByRole('button', { name: `Bloquear ${room.name}`, exact: true })).toBeVisible();
  await adminApi.write(`/rooms/${room.id}/block`, { reason: 'Motivo atual confirmado pela API' });
  const interval = futureInterval(13);
  await page.goto(`/reservations/new?${new URLSearchParams({room_id:String(room.id),start:localInput(interval.start),end:localInput(interval.end),people:'2'})}`);
  await expect(page.getByRole('main')).toContainText(/bloqueada|indisponível para novas reservas/i);
  const confirm = page.getByRole('button', { name: 'Confirmar reserva', exact: true });
  if (await confirm.count()) await expect(confirm).toBeDisabled();
  await capture(page, info, 'blocked-room-direct-url');
  await assertNoOverflow(page);
  const reservations = await adminApi.get<PageResult<Reservation>>(`/reservations?room_id=${room.id}`);
  expect(reservations.count).toBe(0);
});
