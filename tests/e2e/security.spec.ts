import { request } from '@playwright/test';
import { test, expect, accounts, login, unique, assertNoOverflow, assertA11y, capture } from './support.js';

test('login inválido é genérico; sessão persiste e logout invalida cookie anterior', async ({ page }, info) => {
  await page.goto('/login');
  await page.getByLabel(/^E-mail$/i).fill(accounts.member.email);
  await page.getByLabel(/^Senha$/i).fill('SenhaInvalidaQA');
  const invalid = page.waitForResponse(response => response.url().endsWith('/api/session/login') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /^Entrar$/i }).click();
  expect((await invalid).status()).toBe(401);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await assertA11y(page, info, 'login-invalid');
  await page.getByLabel(/^Senha$/i).fill(accounts.member.password);
  await page.getByRole('button', { name: /^Entrar$/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.reload();
  await expect(page.getByRole('button', { name: /^Sair da conta$/i })).toBeVisible();
  const oldState = await page.context().storageState();
  expect(oldState.origins.every(origin => origin.localStorage.length === 0), 'No authentication state in localStorage').toBe(true);
  await page.getByRole('button', { name: /^Sair da conta$/i }).click();
  await expect(page).toHaveURL(/\/login$/);
  const stale = await request.newContext({ baseURL: process.env.BASE_URL, storageState: oldState });
  try {
    expect((await stale.get('/api/rooms')).status()).toBe(401);
    expect(await (await stale.get('/api/session/me')).json()).toEqual({ user: null });
  } finally { await stale.dispose(); }
  await page.goto('/reservations');
  await expect(page).toHaveURL(/\/login/);
});

test('membro não acessa dados alheios nem administração; 403 e 404 navegáveis', async ({ page, adminApi, memberApi }, info) => {
  const room = await adminApi.createRoom(unique('Privacidade QA'));
  const hidden = await adminApi.createReservation(room, unique('Título privado do admin'));
  const forbidden = await memberApi.get<{ error: { code: string } }>(`/reservations/${hidden.id}`, 403);
  expect(forbidden.error.code).toBe('FORBIDDEN');
  expect(JSON.stringify(forbidden)).not.toContain(hidden.title);
  const cancelled = await memberApi.write(`/reservations/${hidden.id}/cancel`, {}, 403);
  expect(JSON.stringify(cancelled)).not.toContain(hidden.title);
  const mine = await memberApi.get('/reservations?scope=mine');
  expect(JSON.stringify(mine)).not.toContain(hidden.id);
  expect(JSON.stringify(mine)).not.toContain(hidden.title);
  const availability = await memberApi.get(`/availability?starts_at=${encodeURIComponent(hidden.starts_at)}&ends_at=${encodeURIComponent(hidden.ends_at)}`);
  expect(JSON.stringify(availability)).not.toContain(hidden.title);
  expect(JSON.stringify(availability)).not.toContain(accounts.admin.email);
  await memberApi.get('/reservations?scope=all', 403);
  await memberApi.get('/audit-events', 403);
  await memberApi.write(`/rooms/${room.id}`, { capacity: 5 }, 403, 'PATCH');
  for (const action of ['block', 'unblock', 'deactivate', 'reactivate']) {
    await memberApi.write(`/rooms/${room.id}/${action}`, { reason: 'Tentativa negada QA' }, 403);
  }
  expect((await adminApi.get<{status: string}>(`/rooms/${room.id}`)).status).toBe('active');
  await memberApi.write('/rooms', { name: unique('Proibida'), capacity: 5 }, 403);
  await memberApi.get('/reservations/00000000-0000-4000-8000-000000000000', 404);
  await login(page);
  await expect(page.getByRole('link', { name: /^Auditoria$/i })).toHaveCount(0);
  await page.goto('/admin/rooms');
  await expect(page.getByRole('main')).toContainText(/403|acesso negado|sem permissão/i);
  await assertA11y(page, info, '403');
  await assertNoOverflow(page);
  await capture(page, info, '403');
  await page.goto(`/pagina-inexistente-${unique('qa').replaceAll(' ', '-')}`);
  await expect(page.getByRole('main')).toContainText(/404|não encontrad/i);
  await assertA11y(page, info, '404');
  await assertNoOverflow(page);
  await capture(page, info, '404');
  await adminApi.write(`/reservations/${hidden.id}/cancel`);
});
