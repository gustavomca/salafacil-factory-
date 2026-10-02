import { test as base, expect, request, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { AxeBuilder } from '@axe-core/playwright';

export const accounts = {
  admin: { email: 'admin@salafacil.local', password: 'AdminLocal!2026' },
  member: { email: 'membro@salafacil.local', password: 'MembroLocal!2026' },
} as const;
export type Room = {
  id: number; name: string; status: 'active' | 'blocked' | 'inactive';
  capacity: number; location: string; blocked_reason: string;
};
export type Reservation = {
  id: string; title: string; description: string; status: 'confirmed' | 'cancelled';
  room: Room; starts_at: string; ends_at: string; participants: number; cancelled_at: string | null;
};
export type PageResult<T> = { count: number; results: T[] };

export class Api {
  constructor(readonly context: APIRequestContext, private csrf: string) {}
  async get<T>(path: string, status = 200): Promise<T> {
    const response = await this.context.get(`/api${path}`);
    expect(response.status(), `${path}: ${await response.text()}`).toBe(status);
    return response.json() as Promise<T>;
  }
  async write<T>(path: string, data: unknown = {}, status = 200, method = 'POST'): Promise<T> {
    const response = await this.context.fetch(`/api${path}`, {
      method, data, headers: { 'X-CSRFToken': this.csrf, Origin: process.env.BASE_URL! },
    });
    expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(status);
    return response.json() as Promise<T>;
  }
  async createRoom(name: string): Promise<Room> {
    return this.write<Room>('/rooms', { name, capacity: 12, location: 'Andar QA', description: 'Sala criada pela suíte integrada.', resources: ['whiteboard', 'projector'] }, 201);
  }
  async createReservation(room: Room, title: string, interval = futureInterval(), participants = 3): Promise<Reservation> {
    return this.write<Reservation>('/reservations', { room_id: room.id, title, description: 'Reunião integrada QA', participants, starts_at: interval.start, ends_at: interval.end }, 201);
  }
}

async function apiSession(role: keyof typeof accounts): Promise<Api> {
  const context = await request.newContext({ baseURL: process.env.BASE_URL });
  const initial = await context.get('/api/session/csrf');
  expect(initial.status()).toBe(200);
  const login = await context.post('/api/session/login', {
    data: accounts[role],
    headers: { 'X-CSRFToken': (await initial.json()).csrf_token, Origin: process.env.BASE_URL! },
  });
  expect(login.status(), `API fixture login (${role}): ${await login.text()}`).toBe(200);
  const fresh = await context.get('/api/session/csrf');
  expect(fresh.status()).toBe(200);
  return new Api(context, (await fresh.json()).csrf_token as string);
}

type WorkerFixtures = { adminApi: Api; memberApi: Api };
export const test = base.extend<{}, WorkerFixtures>({
  adminApi: [async ({}, use) => {
    const api = await apiSession('admin');
    await use(api);
    await api.context.dispose();
  }, { scope: 'worker' }],
  memberApi: [async ({}, use) => {
    const api = await apiSession('member');
    await use(api);
    await api.context.dispose();
  }, { scope: 'worker' }],
});
export { expect };

export function unique(prefix: string): string { return `${prefix} ${randomUUID().slice(0, 8)}`; }
export function futureInterval(days = 2): { start: string; end: string } {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + days);
  start.setUTCHours(15, 0, 0, 0);
  return { start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString() };
}
export function localDate(iso: string, timeZone = 'America/Sao_Paulo'): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
export function localTime(iso: string, timeZone = 'America/Sao_Paulo'): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}
export const localInput = (iso: string, zone = 'America/Sao_Paulo') => `${localDate(iso, zone)}T${localTime(iso, zone)}`;

/** Inspect actual focus before the test moves it; never repair product focus here. */
export async function assertSuccessFocus(page: Page, message: RegExp): Promise<void> {
  const focused = page.getByRole('note', { name: 'Confirmação', exact: true });
  await expect(focused).toBeFocused();
  await expect(focused).toContainText(message);
  await expect(focused).toBeVisible();
  expect(await focused.evaluate(node => node !== document.body && node !== document.documentElement && node.isConnected)).toBe(true);
}
export async function login(page: Page, role: keyof typeof accounts = 'member'): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/^E-mail$/i).fill(accounts[role].email);
  await page.getByLabel(/^Senha$/i).fill(accounts[role].password);
  await page.getByRole('button', { name: /^Entrar$/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.waitForLoadState('networkidle');
}
export async function assertNoOverflow(page: Page): Promise<void> {
  const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, body: document.body.scrollWidth, document: document.documentElement.scrollWidth }));
  expect(sizes.document, `document width exceeds ${sizes.viewport}px viewport`).toBeLessThanOrEqual(sizes.viewport + 1);
  expect(sizes.body, `body width exceeds ${sizes.viewport}px viewport`).toBeLessThanOrEqual(sizes.viewport + 1);
}
export async function assertA11y(page: Page, info: TestInfo, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  await info.attach(`axe-${label}`, { body: JSON.stringify({ url: page.url(), violations: results.violations }, null, 2), contentType: 'application/json' });
  expect(results.violations, `WCAG A/AA violations at ${page.url()}`).toEqual([]);
}
export async function capture(page: Page, info: TestInfo, label: string, fullPage = true): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${label}.png`), fullPage });
}

export async function findRoom(page: Page, room: Room, interval = futureInterval()): Promise<void> {
  await page.goto('/rooms');
  await chooseAvailableRoom(page, room, interval);
}

/** Search and choose within the current document; deliberately does not navigate. */
export async function chooseAvailableRoom(page: Page, room: Room, interval = futureInterval(), participants?: string): Promise<void> {
  await page.getByLabel('Início da busca', { exact: true }).fill(`${localDate(interval.start)}T${localTime(interval.start)}`);
  await page.getByLabel('Término da busca', { exact: true }).fill(`${localDate(interval.end)}T${localTime(interval.end)}`);
  if (participants !== undefined) await page.getByLabel('Pessoas na busca', { exact: true }).fill(participants);
  const initial = page.waitForResponse(response => response.url().includes('/api/availability?'));
  await page.getByRole('button', { name: /^Buscar salas$/i }).click();
  expect((await initial).status()).toBe(200);
  await expect(page.getByRole('button', { name: /^Buscar salas$/i })).toBeEnabled();
  const reserve = page.getByRole('button', { name: `Reservar ${room.name}`, exact: true });
  for (let traversed = 0; await reserve.count() === 0; traversed++) {
    expect(traversed, 'room must appear in real availability pagination').toBeLessThan(50);
    const next = page.getByRole('button', { name: 'Próxima', exact: true });
    await expect(next).toBeEnabled();
    const response = page.waitForResponse(r => r.url().includes('/api/availability?'));
    await next.click();
    expect((await response).status()).toBe(200);
    await expect(page.getByRole('button', { name: /^Buscar salas$/i })).toBeEnabled();
  }
  await reserve.click();
  await expect(page.getByLabel(/^Título da reunião$/i)).toBeVisible();
}
export async function fillReservation(page: Page, title: string, description = 'Pauta QA preservada', participants = '3'): Promise<void> {
  await page.getByLabel(/^Título da reunião$/i).fill(title);
  await page.getByLabel(/^Participantes$/i).fill(participants);
  await page.getByRole('textbox', { name: /^Descrição \(opcional\)$/i }).fill(description);
}
