import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, queryString, refreshCsrf, request } from "./api";
import { useQuery, useTick } from "./hooks";
import {
  browserZone,
  estimatedNow,
  formatDate,
  localValue,
  localDayRange,
  offsetLabel,
  rangeError,
  suggestedStart,
} from "./time";
import {
  DateTimeField,
  Empty,
  ErrorPanel,
  FieldError,
  fieldErrorProps,
  Loading,
  isPageError,
  Notice,
  PageHeading,
  Pagination,
  resolveLocal,
  Status,
  type LocalInput,
} from "./ui";
import { BookingRows, CancelDialog } from "./reservations";
import {
  resources,
  type Dashboard,
  type Page,
  type Reservation,
  type Room,
} from "./types";
import { useSession } from "./session";
import { useDraftState, useClearDraft } from "./drafts";
const futureFields = () => {
  const start = suggestedStart();
  return {
    start: { value: start === null ? "" : localValue(start), choice: "" },
    end: {
      value: start === null ? "" : localValue(start + 3600000),
      choice: "",
    },
  };
};
export function RoomRows({
  rooms,
  choose,
  selectedId,
}: {
  rooms: Room[];
  choose: (room: Room) => void;
  selectedId?: number;
}) {
  return (
    <div className="room-list">
      {rooms.map((room, index) => (
        <article
          className={`room-card ${selectedId === room.id ? "chosen" : ""}`}
          key={room.id}
        >
          <span
            className={`room-monogram tone-${index % 3}`}
            aria-hidden="true"
          >
            {room.name.replace(/^Sala\s+/i, "").slice(0, 1)}
          </span>
          <div className="room-info">
            <div className="room-name">
              <h3>{room.name}</h3>
              <Status status={room.status} />
            </div>
            <p className="location">⌖ {room.location}</p>
            <p className="resources">
              Até {room.capacity} pessoas
              {room.resources.map((r) => (
                <span key={r}> · {resources[r]}</span>
              ))}
            </p>
            {room.description && (
              <p className="room-description">{room.description}</p>
            )}
            {room.blocked_reason && (
              <p className="room-warning">{room.blocked_reason}</p>
            )}
          </div>
          {room.status === "active" ? (
            <button
              className="secondary room-action"
              aria-label={`Reservar ${room.name}`}
              onClick={() => choose(room)}
            >
              Reservar <span aria-hidden="true">→</span>
            </button>
          ) : (
            <span className="help">Indisponível para novas reservas</span>
          )}
        </article>
      ))}
    </div>
  );
}
export function ReservationForm({
  room,
  initialStart,
  initialEnd,
  initialPeople,
  draftKey,
  onRefresh,
  onClose,
}: {
  room: Room;
  initialStart: LocalInput;
  initialEnd: LocalInput;
  initialPeople: string;
  draftKey?: string;
  onRefresh: (start: LocalInput, end: LocalInput, people: string) => void;
  onClose: () => void;
}) {
  const prefix = `reservation:${draftKey ?? JSON.stringify([room.id, initialStart.value, initialStart.choice, initialEnd.value, initialEnd.choice, initialPeople])}:`;
  const clearDraft = useClearDraft();
  const [title, setTitle] = useDraftState(prefix + "title", "");
  const [description, setDescription] = useDraftState(
    prefix + "description",
    "",
  );
  const [start, setStart] = useDraftState(prefix + "start", initialStart);
  const [end, setEnd] = useDraftState(prefix + "end", initialEnd);
  const [people, setPeople] = useDraftState(
    prefix + "people",
    initialPeople || "1",
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Reservation | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  useTick(10000);
  const first = resolveLocal(start),
    last = resolveLocal(end);
  const expired =
    first && estimatedNow() !== null && first.epoch < (estimatedNow() ?? 0);
  const duration = first && last ? (last.epoch - first.epoch) / 60000 : null;
  const uncertain = error instanceof ApiError && error.uncertain;
  async function recalculate() {
    if (busy || uncertain) return;
    setBusy(true);
    try {
      await refreshCsrf();
      const value = suggestedStart();
      if (value === null)
        throw new Error("Não foi possível sincronizar o horário do servidor.");
      const minutes =
        duration && duration >= 15 && duration <= 480 ? duration : 60;
      setStart({ value: localValue(value), choice: "" });
      setEnd({ value: localValue(value + minutes * 60000), choice: "" });
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  function close() {
    clearDraft(prefix);
    onClose();
  }
  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    if (busy || uncertain || created || room.status !== "active") return;
    const invalid = rangeError(first, last);
    if (invalid) {
      setError(new Error(invalid));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await request<Reservation>("/reservations", {
        method: "POST",
        body: {
          room_id: room.id,
          title,
          description,
          starts_at: first!.iso,
          ends_at: last!.iso,
          participants: Number(people),
        },
      });
      clearDraft(prefix);
      setCreated(result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="inline-reservation" aria-label="Nova reserva">
      <form onSubmit={submit}>
        <div className="form-head">
          <span className="eyebrow">NOVA RESERVA</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Fechar nova reserva"
            onClick={close}
          >
            ×
          </button>
        </div>
        <h2>Um espaço para sua ideia.</h2>
        <div className="selected-room">
          <span className="room-monogram tone-0" aria-hidden="true">
            ▥
          </span>
          <div>
            <strong>{room.name}</strong>
            <small>
              {room.location} · até {room.capacity} pessoas
            </small>
          </div>
        </div>
        {created ? (
          <Notice>
            Reserva confirmada. Seu encontro já está na agenda.{" "}
            <Link to={`/reservations/${created.id}`}>Ver detalhes</Link> ·{" "}
            <Link to="/reservations">Ver minhas reservas</Link>
          </Notice>
        ) : null}
        <ErrorPanel
          error={error}
          review={{ to: "/reservations", label: "Consultar minhas reservas" }}
        >
          {error instanceof ApiError && error.status === 409 && (
            <button
              type="button"
              className="text-button"
              onClick={() => onRefresh(start, end, people)}
            >
              Atualizar disponibilidade
            </button>
          )}
        </ErrorPanel>
        {(expired ||
          (error instanceof ApiError && Boolean(error.details.starts_at))) &&
          !created && (
            <div className="message error" role="status">
              Confira o início da reserva. Seus dados foram mantidos.{" "}
              <button
                type="button"
                className="text-button"
                onClick={recalculate}
              >
                Recalcular horário futuro
              </button>
            </div>
          )}
        {room.status !== "active" && (
          <Notice tone="error" focus={false}>
            A sala está {room.status === "blocked" ? "bloqueada" : "inativa"}.{" "}
            {room.blocked_reason} Escolha outra sala; esta não aceita novas
            reservas.
          </Notice>
        )}
        <fieldset
          disabled={
            busy || Boolean(created) || uncertain || room.status !== "active"
          }
        >
          <label>
            Título da reunião
            <input
              ref={titleRef}
              required
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ex.: Planejamento da semana"
              {...fieldErrorProps(error, "title")}
            />
          </label>
          <FieldError error={error} name="title" />
          <DateTimeField
            label="Início da reserva"
            input={start}
            onChange={setStart}
            inputAttributes={fieldErrorProps(error, "starts_at")}
            error={<FieldError error={error} name="starts_at" />}
          />
          <DateTimeField
            label="Término da reserva"
            input={end}
            onChange={setEnd}
            inputAttributes={fieldErrorProps(error, "ends_at")}
            error={<FieldError error={error} name="ends_at" />}
          />
          <p className="help">
            {browserZone()}
            {first ? ` · ${offsetLabel(first.offset)}` : ""}
            {duration !== null ? ` · ${duration} min de duração real` : ""}.
            Permitido: 15 min a 8 h.
          </p>
          <label>
            Participantes
            <input
              type="number"
              min="1"
              max={Math.min(room.capacity, 100)}
              required
              value={people}
              onChange={(e) => setPeople(e.target.value)}
              {...fieldErrorProps(error, "participants")}
            />
          </label>
          <FieldError error={error} name="participants" />
          <label>
            Descrição (opcional)
            <textarea
              rows={3}
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              {...fieldErrorProps(error, "description")}
            />
          </label>
          <FieldError error={error} name="description" />
          <p className="help">
            A disponibilidade será verificada novamente ao confirmar. Horários
            sugeridos usam a referência do servidor.
          </p>
          <div className="form-footer">
            <button type="button" className="secondary" onClick={close}>
              Voltar
            </button>
            <button className="primary" disabled={Boolean(expired)}>
              {busy ? "Confirmando…" : "Confirmar reserva"}
            </button>
          </div>
        </fieldset>
      </form>
    </aside>
  );
}
export function RoomsExplorer({ booking = false }: { booking?: boolean }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [initial] = useState(futureFields);
  const [start, setStart] = useState<LocalInput>({
    value: params.get("start") ?? initial.start.value,
    choice: params.get("start_choice") ?? "",
  });
  const [end, setEnd] = useState<LocalInput>({
    value: params.get("end") ?? initial.end.value,
    choice: params.get("end_choice") ?? "",
  });
  const [people, setPeople] = useState(params.get("people") ?? "");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [capacity, setCapacity] = useState("");
  const [resource, setResource] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [availability, setAvailability] = useState(false);
  const [page, setPage] = useState(1);
  const serialized = params.toString();
  useEffect(() => {
    const values = new URLSearchParams(serialized);
    setStart({
      value: values.get("start") ?? initial.start.value,
      choice: values.get("start_choice") ?? "",
    });
    setEnd({
      value: values.get("end") ?? initial.end.value,
      choice: values.get("end_choice") ?? "",
    });
    setPeople(values.get("people") ?? "");
  }, [serialized, initial]);
  const roomId = booking ? Number(params.get("room_id")) : 0;
  const bookingStart = {
    value: params.get("start") ?? initial.start.value,
    choice: params.get("start_choice") ?? "",
  };
  const bookingEnd = {
    value: params.get("end") ?? initial.end.value,
    choice: params.get("end_choice") ?? "",
  };
  const bookingPeople = params.get("people") ?? "";
  const bookingIntent = JSON.stringify([
    roomId,
    params.get("start") ?? "",
    params.get("start_choice") ?? "",
    params.get("end") ?? "",
    params.get("end_choice") ?? "",
    params.get("people") ?? "",
  ]);
  const selected = useQuery<Room>(roomId > 0 ? `/rooms/${roomId}` : null);
  const path = availability
    ? `/availability?${query}&page=${page}&page_size=20`
    : `/rooms?${query}&page=${page}&page_size=20`;
  const result = useQuery<Page<Room>>(path);
  function find(
    event?: React.SubmitEvent,
    values?: { start: LocalInput; end: LocalInput; people: string },
  ) {
    event?.preventDefault();
    const s = values?.start ?? start,
      e = values?.end ?? end,
      p = values?.people ?? people;
    const first = resolveLocal(s),
      last = resolveLocal(e);
    const invalid = rangeError(first, last);
    if (invalid) {
      setError(new Error(invalid));
      return;
    }
    setError(null);
    setStart(s);
    setEnd(e);
    setPeople(p);
    setAvailability(true);
    setPage(1);
    setQuery(
      queryString({
        starts_at: first!.iso,
        ends_at: last!.iso,
        participants: p,
      }),
    );
    result.reload();
  }
  function choose(room: Room) {
    const p = new URLSearchParams({
      room_id: String(room.id),
      start: start.value,
      end: end.value,
      start_choice: start.choice,
      end_choice: end.choice,
      people,
    });
    navigate(`/reservations/new?${p}`);
  }
  return (
    <>
      <section className="find">
        <div className="search-heading">
          <h2>Encontre um horário</h2>
          <span>{browserZone()} · seu fuso local</span>
        </div>
        <form className="search-form" onSubmit={find}>
          <DateTimeField
            label="Início da busca"
            input={start}
            onChange={setStart}
          />
          <DateTimeField
            label="Término da busca"
            input={end}
            onChange={setEnd}
          />
          <label>
            Pessoas na busca
            <input
              type="number"
              min="1"
              max="100"
              value={people}
              onChange={(e) => setPeople(e.target.value)}
              placeholder="Opcional"
            />
          </label>
          <button className="primary" disabled={result.loading}>
            {result.loading ? "Buscando…" : "Buscar salas"}
          </button>
        </form>
        <ErrorPanel error={error} />
        <button
          className="text-button"
          type="button"
          onClick={async () => {
            try {
              await refreshCsrf();
              const future = futureFields();
              setStart(future.start);
              setEnd(future.end);
              setError(null);
            } catch (err) {
              setError(err);
            }
          }}
        >
          Recalcular horário futuro
        </button>
      </section>
      <div className={booking && roomId ? "split" : ""}>
        {booking && roomId > 0 && (
          <>
            {selected.loading ? (
              <Loading label="Carregando sala…" />
            ) : selected.error ? (
              <ErrorPanel error={selected.error} />
            ) : (
              selected.data && (
                <ReservationForm
                  key={bookingIntent}
                  draftKey={bookingIntent}
                  room={selected.data}
                  initialStart={bookingStart}
                  initialEnd={bookingEnd}
                  initialPeople={bookingPeople}
                  onRefresh={(s, e, p) => {
                    selected.reload();
                    find(undefined, { start: s, end: e, people: p });
                  }}
                  onClose={() => {
                    setParams({});
                    navigate("/rooms");
                  }}
                />
              )
            )}
          </>
        )}
        <section className="results">
          <div className="section-title">
            <div>
              <h2>
                {availability
                  ? "Salas para o seu horário"
                  : "Encontre o seu espaço"}
              </h2>
              <p>
                {availability
                  ? "Disponibilidade consultada para o intervalo informado."
                  : "Uma boa conversa começa no lugar certo."}
              </p>
            </div>
            {result.data && (
              <span className="help">{result.data.count} salas</span>
            )}
          </div>
          <details className="directory-filters">
            <summary>Consultar catálogo de salas</summary>
            <form
              className="filters"
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                setAvailability(false);
                setPage(1);
                setQuery(
                  queryString({
                    search,
                    capacity,
                    resources: resource,
                    status,
                  }),
                );
                result.reload();
              }}
            >
              <label>
                Nome da sala
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <label>
                Capacidade mínima
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={capacity}
                  onChange={(e) => setCapacity(e.target.value)}
                />
              </label>
              <label>
                Recurso
                <select
                  value={resource}
                  onChange={(e) => setResource(e.target.value)}
                >
                  <option value="">Todos</option>
                  {Object.entries(resources).map(([key, label]) => (
                    <option value={key} key={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Estado da sala
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">Todos</option>
                  <option value="active">Ativa</option>
                  <option value="blocked">Bloqueada</option>
                </select>
              </label>
              <button className="secondary">Filtrar catálogo</button>
            </form>
          </details>
          <ErrorPanel
            error={result.error}
            onRetry={
              isPageError(result.error) ? () => setPage(1) : result.reload
            }
            retryLabel={
              isPageError(result.error) ? "Voltar à primeira página" : undefined
            }
          />
          {result.loading ? (
            <Loading label="Consultando salas…" />
          ) : (
            result.data && (
              <>
                {result.data.results.length ? (
                  <RoomRows
                    rooms={result.data.results}
                    choose={choose}
                    selectedId={roomId}
                  />
                ) : (
                  <Empty
                    title={
                      availability
                        ? "Nenhuma sala neste intervalo"
                        : "Nenhuma sala encontrada"
                    }
                  >
                    Tente outro horário, altere os filtros ou reduza o número de
                    participantes.
                  </Empty>
                )}
                <Pagination page={page} {...result.data} onChange={setPage} />
              </>
            )
          )}
          <p className="help availability-note">
            ◷ A disponibilidade só é confirmada ao concluir a reserva.
          </p>
        </section>
      </div>
      {booking && !roomId && (
        <p className="message">
          Selecione uma sala para preencher sua reserva.
        </p>
      )}
    </>
  );
}
export function RoomsPage({ booking = false }: { booking?: boolean }) {
  return (
    <>
      <PageHeading
        title={
          booking
            ? "Prepare seu próximo encontro."
            : "Uma sala. O horário certo."
        }
        description="Encontre uma sala, combine as ideias e faça acontecer."
        eyebrow="DISPONIBILIDADE DE SALAS"
      />
      <RoomsExplorer booking={booking} />
    </>
  );
}
export function DashboardPage() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  useTick(30000);
  const now = estimatedNow();
  const today = now === null ? null : localValue(now).slice(0, 10);
  const selectedDate = params.get("date") ?? today;
  const range = selectedDate
    ? localDayRange(selectedDate, browserZone())
    : null;
  const result = useQuery<Dashboard>(
    selectedDate
      ? `/dashboard?${queryString({ date: selectedDate, tz: browserZone() })}`
      : null,
  );
  const [cancel, setCancel] = useState<Reservation | null>(null);
  const [notice, setNotice] = useState("");
  const dayQuery = range
    ? queryString({
        view: "all",
        status: "confirmed",
        from: range.from,
        to: range.to,
        from_local: localValue(Date.parse(range.from)),
        to_local: localValue(Date.parse(range.to)),
        from_choice: String(Date.parse(range.from)),
        to_choice: String(Date.parse(range.to)),
      })
    : "";
  const isToday = selectedDate === today;
  return (
    <>
      <PageHeading
        eyebrow={
          selectedDate && range
            ? formatDate(`${selectedDate}T12:00:00`, {
                weekday: "long",
                day: "2-digit",
                month: "long",
              }).toLocaleUpperCase("pt-BR")
            : "SUA AGENDA"
        }
        title="Sua agenda, em dia."
        description="Veja seus compromissos e encontre espaço para o próximo."
      >
        {result.data && (
          <div className="day-count" role="group" aria-label="Resumo da agenda">
            <strong>{result.data.counts.my_today}</strong>
            <span>reservas suas {isToday ? "hoje" : "neste dia"}</span>
            <i />
            <strong>{result.data.counts.available_now}</strong>
            <span>salas livres agora</span>
          </div>
        )}
      </PageHeading>
      <div className="agenda-date">
        <label>
          Dia da agenda
          <input
            type="date"
            value={selectedDate ?? ""}
            onChange={(e) => {
              if (e.target.value) setParams({ date: e.target.value });
            }}
          />
        </label>
        <button className="text-button" onClick={() => setParams({})}>
          Hoje
        </button>
      </div>
      {notice && <Notice>{notice}</Notice>}
      <ErrorPanel error={result.error} onRetry={result.reload} />
      {result.loading ? (
        <Loading label="Carregando sua agenda…" />
      ) : (
        result.data && (
          <>
            <section className="day-agenda">
              <div className="section-title">
                <h2>Seu dia</h2>
                <Link className="text-button" to={`/reservations?${dayQuery}`}>
                  Ver todas as reservas deste dia →
                </Link>
              </div>
              <p className="help">
                {result.data.counts.my_today} reservas neste dia; até 5 exibidas
                abaixo.
              </p>
              <BookingRows
                items={result.data.today}
                emptyKind="today"
                onCancel={(reservation) => {
                  setNotice("");
                  setCancel(reservation);
                }}
              />
            </section>
            {user?.role === "admin" && (
              <section
                className="admin-counts"
                aria-label="Panorama do escritório"
              >
                <Link to="/admin/rooms?status=active">
                  <strong>{result.data.counts.active_rooms}</strong> salas
                  ativas
                </Link>
                <Link to="/admin/rooms?status=blocked">
                  <strong>{result.data.counts.blocked_rooms}</strong> salas
                  bloqueadas
                </Link>
                <Link to={`/admin/reservations?${dayQuery}`}>
                  <strong>{result.data.counts.reservations_today}</strong>{" "}
                  reservas {isToday ? "hoje" : "neste dia"} no escritório
                </Link>
              </section>
            )}
          </>
        )
      )}
      <RoomsExplorer />
      {result.data && (
        <section className="up-next">
          <div className="section-title">
            <h2>Seus próximos encontros</h2>
            <Link className="text-button" to="/reservations?view=upcoming">
              Ver próximas e em andamento →
            </Link>
          </div>
          <p className="help">
            {result.data.counts.my_upcoming} encontros por começar; até 5
            exibidos abaixo.
          </p>
          <BookingRows
            items={result.data.upcoming}
            emptyKind="upcoming"
            onCancel={(reservation) => {
              setNotice("");
              setCancel(reservation);
            }}
          />
        </section>
      )}
      {cancel && (
        <CancelDialog
          reservation={cancel}
          onClose={() => setCancel(null)}
          onCancelled={() => {
            setCancel(null);
            setNotice(
              "Reserva cancelada. O registro foi mantido no histórico.",
            );
            result.reload();
          }}
        />
      )}
    </>
  );
}
