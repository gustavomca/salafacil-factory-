export const browserZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;
const partsFormatter = (zone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
function wallParts(epoch: number, zone: string) {
  const parts = partsFormatter(zone).formatToParts(epoch);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}
const pad = (n: number) => String(n).padStart(2, "0");
export function localValue(epoch: number, zone = browserZone()) {
  const p = wallParts(epoch, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
export function offsetLabel(offset: number) {
  return `UTC${offset >= 0 ? "+" : "−"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
export interface LocalCandidate {
  epoch: number;
  iso: string;
  offset: number;
}
/** Round-trip all offsets around the local date; gaps have no candidates, folds have two. */
export function localCandidates(
  value: string,
  zone = browserZone(),
): LocalCandidate[] {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return [];
  const [year, month, day, hour, minute] = value.split(/[-T:]/).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  if (!Number.isFinite(wall)) return [];
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const instant = wall + hours * 3600000;
    const p = wallParts(instant, zone);
    offsets.add(
      Math.round(
        (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
          instant) /
          60000,
      ),
    );
  }
  return [...offsets]
    .map((offset) => ({
      offset,
      epoch: wall - offset * 60000,
      iso: `${value}:00${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`,
    }))
    .filter((c) => localValue(c.epoch, zone) === value)
    .sort((a, b) => a.epoch - b.epoch);
}
let baseline: number | null = null;
let sampledAt = 0;
let clockRevision = 0;
export const clockSnapshot = () => clockRevision;
export function subscribeClock(notify: () => void) {
  window.addEventListener("salafacil:clock-synced", notify);
  return () => window.removeEventListener("salafacil:clock-synced", notify);
}
export function syncClock(serverNow: string, sent: number, received: number) {
  const value = Date.parse(serverNow);
  if (Number.isFinite(value)) {
    baseline = value;
    sampledAt = (sent + received) / 2;
    clockRevision += 1;
    window.dispatchEvent(new Event("salafacil:clock-synced"));
  }
}
export function estimatedNow() {
  return baseline === null ? null : baseline + performance.now() - sampledAt;
}
export function suggestedStart() {
  const now = estimatedNow();
  return now === null ? null : Math.ceil((now + 120000) / 300000) * 300000;
}
export function formatDate(
  value: string | number,
  options?: Intl.DateTimeFormatOptions,
) {
  return new Intl.DateTimeFormat(
    "pt-BR",
    options ?? {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    },
  ).format(new Date(value));
}
export function time(value: string) {
  return formatDate(value, { hour: "2-digit", minute: "2-digit" });
}
export function intervalLabel(start: string, end: string) {
  return `${formatDate(start)} → ${formatDate(end)}`;
}
export function rangeError(
  start: LocalCandidate | undefined,
  end: LocalCandidate | undefined,
  checkFuture = true,
) {
  if (!start || !end)
    return "Confira as datas e selecione o fuso quando o horário for ambíguo.";
  const duration = (end.epoch - start.epoch) / 60000;
  if (duration < 15 || duration > 480)
    return "A duração real deve estar entre 15 minutos e 8 horas.";
  const now = estimatedNow();
  if (checkFuture && now !== null && start.epoch < now)
    return "O início já passou. Recalcule um horário futuro mantendo seus dados.";
  return "";
}

/** Local calendar boundaries; never add 24 hours to a DST day. */
export function localDayRange(date: string, zone = browserZone()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split("-").map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== date
  )
    return null;
  const next = new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
  const start = localCandidates(`${date}T00:00`, zone)[0];
  const end = localCandidates(`${next}T00:00`, zone)[0];
  // Zones with a midnight gap advance to the first actual local minute.
  const first = (day: string) => {
    for (let minute = 0; minute < 180; minute++) {
      const found = localCandidates(
        `${day}T${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`,
        zone,
      )[0];
      if (found) return found;
    }
    return undefined;
  };
  const from = start ?? first(date),
    to = end ?? first(next);
  return from && to ? { from: from.iso, to: to.iso } : null;
}
