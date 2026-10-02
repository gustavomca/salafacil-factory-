import { test, expect, unique, futureInterval, type Api, type Reservation, type PageResult, type Room } from './support.js';

async function availability(api: Api, interval: { start: string; end: string }): Promise<Room[]> {
  const rooms: Room[] = [];
  for (let page = 1; ; page++) {
    const response = await api.get<PageResult<Room>>(`/availability?starts_at=${encodeURIComponent(interval.start)}&ends_at=${encodeURIComponent(interval.end)}&page_size=100&page=${page}`);
    rooms.push(...response.results);
    if (rooms.length >= response.count) return rooms;
    expect(response.results.length, 'pagination must advance').toBeGreaterThan(0);
  }
}

test('API real: bloqueio/inativação preservam reserva, restringem catálogo e impedem novas reservas', async ({ adminApi, memberApi }) => {
  const room = await adminApi.createRoom(unique('Estado e histórico QA'));
  const interval = futureInterval(6);
  expect((await availability(memberApi, interval)).some(item => item.id === room.id)).toBe(true);
  const reservation = await memberApi.createReservation(room, unique('Histórico protegido'), interval, 8);
  const reduced = await adminApi.write<{ error: { code: string } }>(`/rooms/${room.id}`, { capacity: 7 }, 409, 'PATCH');
  expect(reduced.error.code).toBe('ROOM_CAPACITY_CONFLICT');
  const blocked = await adminApi.write<Room & { affected_reservations_count: number }>(`/rooms/${room.id}/block`, { reason: 'Manutenção QA' });
  expect(blocked.status).toBe('blocked');
  expect(blocked.affected_reservations_count).toBe(1);
  expect((await memberApi.get<Reservation>(`/reservations/${reservation.id}`)).status).toBe('confirmed');
  await memberApi.write('/reservations', { room_id: room.id, title: 'Recusada bloqueada', description: '', participants: 1, starts_at: futureInterval(7).start, ends_at: futureInterval(7).end }, 409);
  const availableBlocked = await availability(memberApi, futureInterval(7));
  expect(availableBlocked.some(item => item.id === room.id)).toBe(false);
  await adminApi.write(`/rooms/${room.id}/unblock`);
  const availableOccupied = await availability(memberApi, interval);
  expect(availableOccupied.some(item => item.id === room.id)).toBe(false);
  const inactive = await adminApi.write<Room & { affected_reservations_count: number }>(`/rooms/${room.id}/deactivate`);
  expect(inactive.status).toBe('inactive');
  expect(inactive.affected_reservations_count).toBe(1);
  await memberApi.get(`/rooms/${room.id}`, 403);
  const history = await memberApi.get<Reservation>(`/reservations/${reservation.id}`);
  expect(history.status).toBe('confirmed');
  expect(history.room.status).toBe('inactive');
  const catalog = await memberApi.get<PageResult<Room>>(`/rooms?search=${encodeURIComponent(room.name)}`);
  expect(catalog.results.some(item => item.id === room.id)).toBe(false);
  await memberApi.write('/reservations', { room_id: room.id, title: 'Recusada inativa', description: '', participants: 1, starts_at: futureInterval(7).start, ends_at: futureInterval(7).end }, 403);
  await memberApi.write(`/reservations/${reservation.id}/cancel`);
  const active = await adminApi.write<Room>(`/rooms/${room.id}/reactivate`);
  expect(active.status).toBe('active');
  const again = await memberApi.createReservation(room, unique('Intervalo liberado'), interval);
  await memberApi.write(`/reservations/${again.id}/cancel`);
});

test('API real: CSRF obrigatório e escrita privilegiada rejeitada', async ({ page, memberApi, adminApi }) => {
  const noCsrf = await page.request.post('/api/session/login', { data: { email: 'admin@salafacil.local', password: 'AdminLocal!2026' } });
  expect(noCsrf.status()).toBe(403);
  expect((await noCsrf.json()).error.code).toBe('CSRF_FAILED');
  const room = await adminApi.createRoom(unique('Campos rejeitados QA'));
  const payload = { room_id: room.id, title: unique('Sem dono forjado'), description: '', participants: 1, starts_at: futureInterval().start, ends_at: futureInterval().end };
  const forged = await memberApi.write<{ error: { code: string } }>('/reservations', { ...payload, user_id: 1, status: 'cancelled' }, 400);
  expect(forged.error.code).toBe('VALIDATION_ERROR');
  const result = await memberApi.get<PageResult<Reservation>>(`/reservations?room_id=${room.id}`);
  expect(result.count).toBe(0);
  await adminApi.write(`/rooms/${room.id}`, { status: 'inactive' }, 400, 'PATCH');
  expect((await adminApi.get<Room>(`/rooms/${room.id}`)).status).toBe('active');
});
