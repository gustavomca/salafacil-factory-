import { test, expect, login, unique, futureInterval, localDate, capture, assertNoOverflow, type Reservation } from './support.js';

type Dashboard = {today:Reservation[];upcoming:Reservation[];counts:{my_today:number;available_now:number;my_upcoming:number;reservations_today:number}};

test('contadores reais ficam visíveis em 360/390/tablet/desktop e resumo truncado leva ao dia selecionado', async ({ page, adminApi }, info) => {
  const room = await adminApi.createRoom(unique('Painel com seis reservas'));
  const interval = futureInterval(14);
  const created: Reservation[] = [];
  for (let index = 0; index < 6; index++) {
    const start = Date.parse(interval.start) + index * 3_600_000;
    created.push(await adminApi.createReservation(room, unique(`Encontro painel ${index}`), {start:new Date(start).toISOString(),end:new Date(start+1_800_000).toISOString()}));
  }
  const date = localDate(interval.start);
  await login(page, 'admin');
  const loaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/dashboard' && new URL(r.url()).searchParams.get('date') === date);
  await page.goto(`/dashboard?date=${date}`);
  const response = await loaded;
  expect(response.status()).toBe(200);
  const result = await response.json() as Dashboard;
  expect(result.counts.my_today).toBeGreaterThanOrEqual(6);
  expect(result.today).toHaveLength(5);
  const counters = page.getByRole('group', {name:'Resumo da agenda',exact:true});
  for (const width of info.project.name === 'mobile' ? [390,360] : [1440,1024,768]) {
    await page.setViewportSize({width,height:1000});
    await expect(counters).toBeVisible();
    await expect(counters.getByText('salas livres agora', {exact:true})).toBeVisible();
    await expect(counters.getByText('reservas suas neste dia', {exact:true})).toBeVisible();
    const strong = counters.locator('strong');
    await expect(strong.nth(0)).toHaveText(String(result.counts.my_today));
    await expect(strong.nth(1)).toHaveText(String(result.counts.available_now));
    await expect(strong.nth(0)).toBeVisible();
    await expect(strong.nth(1)).toBeVisible();
    await assertNoOverflow(page);
    await capture(page, info, `dashboard-real-counters-${width}`, false);
  }
  const panorama = page.getByRole('region', {name:'Panorama do escritório',exact:true});
  const officeDay = panorama.getByRole('link', {name:/reservas.*escritório/i});
  await expect(officeDay).toContainText(String(result.counts.reservations_today));
  await officeDay.click();
  await expect(page).toHaveURL(/\/admin\/reservations\?/);
  const params = new URL(page.url()).searchParams;
  expect(params.get('from')).toBeTruthy();
  expect(params.get('to')).toBeTruthy();
  expect(localDate(params.get('from')!)).toBe(date);
  expect(Date.parse(params.get('to')!) - Date.parse(params.get('from')!)).toBe(24 * 3_600_000);
  for (const reservation of created) await expect(page.getByRole('link', {name:reservation.title,exact:true})).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Dia da agenda', {exact:true})).toHaveValue(date);
  await expect(page.getByText(`${result.counts.my_today} reservas neste dia; até 5 exibidas abaixo.`, {exact:true})).toBeVisible();
  const ownDay = page.getByRole('link', {name:'Ver todas as reservas deste dia →',exact:true});
  await expect(ownDay).toBeVisible();
  await ownDay.click();
  await expect(page).toHaveURL(/\/reservations\?/);
  expect(new URL(page.url()).searchParams.get('from')).toBeTruthy();
});
