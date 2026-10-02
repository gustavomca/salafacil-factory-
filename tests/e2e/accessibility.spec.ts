import { test, expect, accounts, unique, assertA11y, assertNoOverflow, capture } from './support.js';

test('teclado, axe, telas administrativas e responsividade sem egress externo', async ({ page }, info) => {
  const runtimeErrors: string[] = [];
  const externalRequests = new Set<string>();
  const origin = new URL(process.env.BASE_URL!).origin;
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('request', req => {
    if (/^https?:/.test(req.url()) && new URL(req.url()).origin !== origin) externalRequests.add(new URL(req.url()).origin);
  });
  await page.goto('/login');
  await expect(page.getByLabel(/^E-mail$/i)).toBeVisible();
  await assertA11y(page, info, 'login');
  await assertNoOverflow(page);
  await capture(page, info, 'login');
  await page.getByLabel(/^E-mail$/i).focus();
  await page.keyboard.type(accounts.admin.email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel(/^Senha$/i)).toBeFocused();
  await page.keyboard.type(accounts.admin.password);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /^Entrar$/i })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/dashboard$/);
  const routes = ['/dashboard', '/rooms', '/reservations', '/admin/rooms', '/admin/reservations', '/admin/audit'];
  for (const route of routes) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await assertNoOverflow(page);
    await assertA11y(page, info, route.replaceAll('/', '-'));
    await capture(page, info, route.replaceAll('/', '-'));
    if (route === '/rooms') {
      await page.getByText('Consultar catálogo de salas', { exact: true }).click();
      await page.getByLabel('Nome da sala', { exact: true }).fill(unique('Nenhuma sala terá este nome QA'));
      await page.getByRole('button', { name: 'Filtrar catálogo', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Nenhuma sala encontrada', exact: true })).toBeVisible();
      await capture(page, info, 'empty-room-directory');
      await assertNoOverflow(page);
    }
    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 360, height: 844 });
      await assertNoOverflow(page);
      await page.setViewportSize({ width: 390, height: 844 });
    }
  }
  expect(runtimeErrors).toEqual([]);
  expect([...externalRequests]).toEqual([]);
});
