import { test, expect, login, unique, localInput, localDate, fillReservation, assertSuccessFocus, assertNoOverflow, assertA11y, capture, type Reservation, type Api } from './support.js';

const zone = 'America/New_York';
const hour = 3_600_000;
const minute = 60_000;
const offsetFormatter = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' });
function offset(epoch: number) {
  const label = offsetFormatter.formatToParts(epoch).find(part => part.type === 'timeZoneName')!.value;
  const match = label.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Unexpected IANA offset: ${label}`);
  return (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3]));
}
type Transition = { epoch: number; before: number; after: number; wall: string; date: string };
/** Discover actual future IANA transitions independently of product time helpers. */
function futureTransitions(serverNow: string) {
  const after = Math.ceil(Date.parse(serverNow) / hour) * hour;
  let fold: Transition | undefined, gap: Transition | undefined;
  let previous = after;
  for (let epoch = after + 6 * hour; epoch < after + 800 * 24 * hour && (!fold || !gap); epoch += 6 * hour) {
    const before = offset(previous), next = offset(epoch);
    if (before !== next) {
      let low = previous, high = epoch;
      while (high - low > minute) {
        const middle = Math.floor((low + high) / (2 * minute)) * minute;
        if (offset(middle) === before) low = middle; else high = middle;
      }
      const change = { epoch: high, before, after: next, wall: '', date: localDate(new Date(high).toISOString(), zone) };
      // The repeated/missing local half-hour has exact candidate instants in NY.
      const wallEpoch = high + Math.min(before, next) * minute + 30 * minute;
      change.wall = new Date(wallEpoch).toISOString().slice(0, 16);
      if (next < before && !fold) fold = change;
      if (next > before && !gap) gap = change;
    }
    previous = epoch;
  }
  expect(fold, 'future IANA fold within 800 days').toBeTruthy();
  expect(gap, 'future IANA gap within 800 days').toBeTruthy();
  return { fold: fold!, gap: gap! };
}
function midnight(date: string) {
  const nominal = Date.parse(`${date}T00:00:00Z`);
  // This independent brute-force roundtrip never assumes 24 elapsed hours/day.
  for (let epoch = nominal - 18 * hour; epoch <= nominal + 18 * hour; epoch += 15 * minute) {
    if (localInput(new Date(epoch).toISOString(), zone) === `${date}T00:00`) return epoch;
  }
  throw new Error(`No local midnight for ${date} ${zone}`);
}
const iso = (epoch: number) => new Date(epoch).toISOString();
type Dashboard = { date: string; tz: string; today: Reservation[]; upcoming: Reservation[]; counts: { my_today: number; my_upcoming: number; available_now: number; reservations_today?: number } };
async function dashboard(api: Api, date: string) { return api.get<Dashboard>(`/dashboard?${new URLSearchParams({date,tz:zone})}`); }

test('DST IANA futuro: lacuna rejeitada, dobra exige offset e agenda real usa dias de 23/25 horas', async ({ browser, adminApi, memberApi }, info) => {
  test.setTimeout(90_000);
  const { server_now } = await memberApi.get<{server_now: string}>('/session/csrf');
  const transitions = futureTransitions(server_now);
  await info.attach('dst-real-clock-and-iana', { body: JSON.stringify({ server_now, zone, transitions, injection: false }, null, 2), contentType: 'application/json' });
  const context = await browser.newContext({ baseURL: process.env.BASE_URL, timezoneId: zone, locale: 'pt-BR', viewport: info.project.name === 'mobile' ? {width:390,height:844} : {width:1440,height:1000}, isMobile: info.project.name === 'mobile', hasTouch: info.project.name === 'mobile' });
  const page = await context.newPage();
  const cleanup: string[] = [];
  try {
    await login(page);
    const room = await adminApi.createRoom(unique('DST real QA'));
    let posts = 0;
    page.on('request', req => { if (new URL(req.url()).pathname === '/api/reservations' && req.method() === 'POST') posts++; });
    const open = async (wall: string, endWall: string) => {
      await page.goto(`/reservations/new?${new URLSearchParams({room_id:String(room.id),start:wall,end:endWall,people:'2'})}`);
      await expect(page.getByLabel('Início da reserva', { exact: true })).toHaveValue(wall);
    };
    const gap = transitions.gap;
    await open(gap.wall, `${gap.date}T03:30`);
    await fillReservation(page, unique('Lacuna não pode criar'));
    await expect(page.getByRole('complementary', {name:'Nova reserva'})).toContainText(/não existe/i);
    const submit = page.getByRole('button', {name:'Confirmar reserva',exact:true});
    if (await submit.isEnabled()) await submit.click();
    expect(posts).toBe(0);
    await capture(page, info, 'dst-gap-rejected');

    const fold = transitions.fold;
    const foldWallEpoch = Date.parse(`${fold.wall}:00Z`);
    const early = foldWallEpoch - fold.before * minute;
    const late = foldWallEpoch - fold.after * minute;
    expect(late - early).toBe(hour);
    const createdIds: string[] = [];
    for (const [index, epoch] of [early, late].entries()) {
      await open(fold.wall, `${fold.date}T01:45`);
      await fillReservation(page, unique(`Dobra escolha ${index + 1}`));
      const startChoice = page.getByRole('combobox', {name:'Início da reserva: escolha o offset',exact:true});
      const endChoice = page.getByRole('combobox', {name:'Término da reserva: escolha o offset',exact:true});
      await expect(startChoice).toHaveValue('');
      await expect(endChoice).toHaveValue('');
      if (await submit.isEnabled()) await submit.click();
      expect(posts).toBe(index);
      await startChoice.selectOption(String(epoch));
      await endChoice.selectOption(String(epoch + 15 * minute));
      await capture(page, info, `dst-fold-offset-${index + 1}`);
      const committed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/reservations' && r.request().method() === 'POST');
      await submit.click();
      const response = await committed;
      expect(response.status()).toBe(201);
      const created = await response.json() as Reservation;
      expect(Date.parse(created.starts_at)).toBe(epoch);
      expect(Date.parse(created.ends_at)).toBe(epoch + 15 * minute);
      await assertSuccessFocus(page, /Reserva confirmada/);
      createdIds.push(created.id);
      cleanup.push(created.id);
      const persisted = await memberApi.get<Reservation>(`/reservations/${created.id}`);
      expect(Date.parse(persisted.starts_at)).toBe(epoch);
    }
    expect(createdIds[0]).not.toBe(createdIds[1]);
    expect(posts).toBe(2);

    for (const [kind, transition, expectedHours] of [['gap', gap, 23], ['fold', fold, 25]] as const) {
      const start = midnight(transition.date);
      const nextDate = new Date(Date.parse(`${transition.date}T12:00:00Z`) + 24 * hour).toISOString().slice(0,10);
      const end = midnight(nextDate);
      expect((end - start) / hour).toBe(expectedHours);
      expect(start).toBeGreaterThan(Date.parse(server_now));
      const boundaryRoom = await adminApi.createRoom(unique(`Dia de ${expectedHours} horas`));
      const before = await dashboard(memberApi, transition.date);
      const outsideBefore = await memberApi.createReservation(boundaryRoom, unique('Termina à meia-noite'), {start:iso(start-30*minute),end:iso(start)});
      const insideStart = await memberApi.createReservation(boundaryRoom, unique('Inicia à meia-noite'), {start:iso(start),end:iso(start+30*minute)});
      const insideEnd = await memberApi.createReservation(boundaryRoom, unique('Termina no fim do dia'), {start:iso(end-30*minute),end:iso(end)});
      const outsideAfter = await memberApi.createReservation(boundaryRoom, unique('Inicia no dia seguinte'), {start:iso(end),end:iso(end+30*minute)});
      cleanup.push(outsideBefore.id, insideStart.id, insideEnd.id, outsideAfter.id);
      const result = await dashboard(memberApi, transition.date);
      expect(result.counts.my_today).toBe(before.counts.my_today + 2);
      const ids = result.today.map(item => item.id);
      expect(ids).toContain(insideStart.id);
      expect(ids).toContain(insideEnd.id);
      expect(ids).not.toContain(outsideBefore.id);
      expect(ids).not.toContain(outsideAfter.id);
      const loaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/dashboard' && new URL(r.url()).searchParams.get('date') === transition.date);
      await page.goto(`/dashboard?date=${transition.date}`);
      const actual = await loaded;
      expect(actual.status()).toBe(200);
      expect(new URL(actual.url()).searchParams.get('tz')).toBe(zone);
      await expect(page.getByLabel('Dia da agenda', {exact:true})).toHaveValue(transition.date);
      await expect(page.getByRole('link',{name:insideStart.title,exact:true}).first()).toBeVisible();
      await expect(page.getByRole('link',{name:insideEnd.title,exact:true}).first()).toBeVisible();
      await assertNoOverflow(page);
      await assertA11y(page, info, `dst-${kind}-dashboard`);
      await capture(page, info, `dst-day-${expectedHours}-hours`);
      await info.attach(`dst-${kind}-boundaries`, {body:JSON.stringify({date:transition.date,zone,start:iso(start),end:iso(end),elapsedHours:expectedHours,counts:result.counts,inside:[insideStart.id,insideEnd.id],excluded:[outsideBefore.id,outsideAfter.id]},null,2),contentType:'application/json'});
    }
  } finally {
    await context.close();
    for (const id of cleanup) await memberApi.write(`/reservations/${id}/cancel`);
  }
});
