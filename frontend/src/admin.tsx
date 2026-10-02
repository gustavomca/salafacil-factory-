import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, queryString, request } from "./api";
import { useQuery } from "./hooks";
import { browserZone, formatDate } from "./time";
import {
  DateTimeField,
  Empty,
  ErrorPanel,
  FieldError,
  fieldErrorProps,
  Loading,
  isPageError,
  Modal,
  Notice,
  PageHeading,
  Pagination,
  resolveLocal,
  Status,
  type LocalInput,
} from "./ui";
import {
  resources,
  type AuditPage,
  type Page,
  type Reservation,
  type Resource,
  type Room,
} from "./types";
import { useDraftState, useClearDraft } from "./drafts";
export function RoomEditor({
  room,
  onClose,
  onSaved,
}: {
  room: Room | null;
  onClose: (refresh?: boolean) => void;
  onSaved: (room: Room) => void;
}) {
  const prefix = `roomEditor:${room?.id ?? "new"}:`;
  const clearDraft = useClearDraft();
  const [name, setName] = useDraftState(prefix + "name", room?.name ?? "");
  const [description, setDescription] = useDraftState(
    prefix + "description",
    room?.description ?? "",
  );
  const [location, setLocation] = useDraftState(
    prefix + "location",
    room?.location ?? "",
  );
  const [capacity, setCapacity] = useDraftState(
    prefix + "capacity",
    String(room?.capacity ?? 8),
  );
  const [selected, setSelected] = useDraftState<Resource[]>(
    prefix + "resources",
    room?.resources ?? [],
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const uncertain = error instanceof ApiError && error.uncertain;
  const changed = error instanceof ApiError && error.status === 409;
  async function submit(e: React.SubmitEvent) {
    e.preventDefault();
    if (busy || uncertain) return;
    setBusy(true);
    setError(null);
    try {
      const data = await request<Room>(room ? `/rooms/${room.id}` : "/rooms", {
        method: room ? "PATCH" : "POST",
        body: {
          name,
          description,
          location,
          capacity: Number(capacity),
          resources: selected,
        },
      });
      clearDraft(prefix);
      onSaved(data);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      label={room ? "Editar sala" : "Nova sala"}
      onClose={() => {
        if (!busy) {
          clearDraft(prefix);
          onClose(uncertain || changed);
        }
      }}
    >
      <h2>{room ? "Editar sala" : "Uma nova sala."}</h2>
      <p>Organize os espaços disponíveis para o escritório.</p>
      <ErrorPanel error={error}>
        {error instanceof ApiError &&
          error.code === "ROOM_CAPACITY_CONFLICT" &&
          room && (
            <Link
              to={`/admin/reservations?room_id=${room.id}&status=confirmed&not_ended=true`}
            >
              Tratar reservas desta sala
            </Link>
          )}
        {uncertain && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              clearDraft(prefix);
              onClose(uncertain || changed);
            }}
          >
            Consultar salas antes de reenviar
          </button>
        )}
      </ErrorPanel>
      <form onSubmit={submit}>
        <fieldset disabled={busy || uncertain}>
          <label>
            Nome da sala
            <input
              autoFocus
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              {...fieldErrorProps(error, "name")}
            />
          </label>
          <FieldError error={error} name="name" />
          <label>
            Localização
            <input
              required
              maxLength={200}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              {...fieldErrorProps(error, "location")}
            />
          </label>
          <FieldError error={error} name="location" />
          <label>
            Capacidade
            <input
              required
              type="number"
              min="1"
              max="100"
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              {...fieldErrorProps(error, "capacity")}
            />
          </label>
          <FieldError error={error} name="capacity" />
          <label>
            Descrição da sala
            <textarea
              maxLength={2000}
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              {...fieldErrorProps(error, "description")}
            />
          </label>
          <FieldError error={error} name="description" />
          <fieldset className="checkbox-group">
            <legend>Recursos</legend>
            {(Object.entries(resources) as [Resource, string][]).map(
              ([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={selected.includes(key)}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked
                          ? [...prev, key]
                          : prev.filter((v) => v !== key),
                      )
                    }
                  />
                  {label}
                </label>
              ),
            )}
          </fieldset>
          <FieldError error={error} name="resources" />
          <div className="form-footer">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                clearDraft(prefix);
                onClose(uncertain || changed);
              }}
            >
              Voltar
            </button>
            <button className="primary">
              {busy ? "Salvando…" : room ? "Salvar alterações" : "Criar sala"}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
type Transition = "block" | "unblock" | "deactivate" | "reactivate";
const actions: Record<Transition, string> = {
  block: "Bloquear sala",
  unblock: "Desbloquear sala",
  deactivate: "Inativar sala",
  reactivate: "Reativar sala",
};
export function RoomTransition({
  room,
  action,
  onClose,
  onSaved,
}: {
  room: Room;
  action: Transition;
  onClose: (refresh?: boolean) => void;
  onSaved: (room: Room) => void;
}) {
  const prefix = `roomTransition:${room.id}:${action}:`;
  const clearDraft = useClearDraft();
  const [reason, setReason] = useDraftState(
    prefix + "reason",
    room.blocked_reason,
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const preview = useQuery<Page<Reservation>>(
    `/reservations?scope=all&room_id=${room.id}&status=confirmed&not_ended=true&page_size=1`,
  );
  const uncertain = error instanceof ApiError && error.uncertain;
  const changed = error instanceof ApiError && error.status === 409;
  function close() {
    clearDraft(prefix);
    onClose(uncertain || changed);
  }
  async function submit(e: React.SubmitEvent) {
    e.preventDefault();
    if (busy || uncertain || !preview.data) return;
    setBusy(true);
    setError(null);
    try {
      const data = await request<Room>(`/rooms/${room.id}/${action}`, {
        method: "POST",
        body: action === "block" ? { reason } : {},
      });
      clearDraft(prefix);
      onSaved(data);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      label={actions[action]}
      onClose={() => {
        if (!busy) close();
      }}
    >
      <h2>{actions[action]}?</h2>
      <div className="summary">
        <strong>{room.name}</strong>
        <span>{room.location}</span>
      </div>
      <p>
        As reservas existentes serão preservadas. Cancelamentos precisam ser
        feitos explicitamente.
      </p>
      {preview.loading ? (
        <Loading label="Consultando reservas afetadas…" />
      ) : (
        <ErrorPanel error={preview.error} onRetry={preview.reload} />
      )}{" "}
      {preview.data && (
        <p className="message">
          {preview.data.count} reservas confirmadas ainda não encerradas nesta
          sala.{" "}
          <Link
            to={`/admin/reservations?room_id=${room.id}&status=confirmed&not_ended=true`}
          >
            Consultar reservas afetadas
          </Link>
        </p>
      )}
      <ErrorPanel error={error}>
        {(uncertain || changed) && (
          <button className="text-button" type="button" onClick={close}>
            Consultar estado da sala
          </button>
        )}
      </ErrorPanel>
      <form onSubmit={submit}>
        {action === "block" && (
          <>
            <label>
              Motivo do bloqueio
              <textarea
                required
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                {...fieldErrorProps(error, "reason")}
              />
            </label>
            <FieldError error={error} name="reason" />
          </>
        )}
        <div className="form-footer">
          <button
            autoFocus
            data-modal-autofocus
            type="button"
            className="secondary"
            disabled={busy}
            onClick={close}
          >
            {uncertain || changed
              ? "Atualizar estado da sala"
              : "Manter estado atual"}
          </button>
          <button
            className={
              action === "block" || action === "deactivate"
                ? "danger"
                : "primary"
            }
            disabled={
              busy || uncertain || changed || preview.loading || !preview.data
            }
          >
            {busy ? "Atualizando…" : actions[action]}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function AdminRooms() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const serialized = params.toString();
  useEffect(() => {
    const p = new URLSearchParams(serialized);
    setSearch(p.get("search") ?? "");
    setStatus(p.get("status") ?? "");
  }, [serialized]);
  const page = Math.max(1, Number(params.get("page")) || 1);
  const data = useQuery<Page<Room>>(
    `/rooms?${queryString({ search: params.get("search") ?? "", status: params.get("status") ?? "", page, page_size: 20 })}`,
  );
  const [editor, setEditor] = useDraftState<Room | null | undefined>(
    "adminRooms:editor",
    undefined,
  );
  const [transition, setTransition] = useDraftState<{
    room: Room;
    action: Transition;
  } | null>("adminRooms:transition", null);
  const [notice, setNotice] = useState<{
    text: string;
    roomId?: number;
  } | null>(null);
  function openTransition(value: { room: Room; action: Transition }) {
    setNotice(null);
    setTransition(value);
  }
  return (
    <>
      <PageHeading
        title="Salas bem cuidadas."
        description="Organização e disponibilidade para todo o escritório."
        eyebrow="ADMINISTRAÇÃO"
      >
        <button
          className="primary"
          onClick={() => {
            setNotice(null);
            setEditor(null);
          }}
        >
          + Nova sala
        </button>
      </PageHeading>
      {notice && (
        <Notice>
          {notice.text}
          {notice.roomId && (
            <>
              {" "}
              <Link
                to={`/admin/reservations?room_id=${notice.roomId}&status=confirmed&not_ended=true`}
              >
                Tratar reservas afetadas
              </Link>
            </>
          )}
        </Notice>
      )}
      <div className="message">
        Bloquear ou inativar preserva as reservas existentes. Revise o total
        afetado antes de confirmar.
      </div>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setParams({ search, status, page: "1" });
          data.reload();
        }}
      >
        <label>
          Buscar salas
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label>
          Estado da sala
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option>
            <option value="active">Ativa</option>
            <option value="blocked">Bloqueada</option>
            <option value="inactive">Inativa</option>
          </select>
        </label>
        <button className="secondary">Filtrar salas</button>
      </form>
      <ErrorPanel
        error={data.error}
        onRetry={
          isPageError(data.error)
            ? () => {
                const next = new URLSearchParams(params);
                next.set("page", "1");
                setParams(next);
              }
            : data.reload
        }
        retryLabel={
          isPageError(data.error) ? "Voltar à primeira página" : undefined
        }
      />
      {data.loading ? (
        <Loading />
      ) : (
        data.data && (
          <>
            {data.data.results.length ? (
              <div className="management-list">
                {data.data.results.map((room) => (
                  <article className="management-row" key={room.id}>
                    <div className="management-info">
                      <h2>{room.name}</h2>
                      <p>
                        {room.location} · {room.capacity} pessoas · ID {room.id}
                      </p>
                      <p>
                        {room.resources.map((r) => resources[r]).join(" · ") ||
                          "Sem recursos adicionais"}
                      </p>
                      {room.blocked_reason && (
                        <p className="room-warning">{room.blocked_reason}</p>
                      )}
                    </div>
                    <Status status={room.status} />
                    <div className="management-actions">
                      <button
                        className="secondary"
                        onClick={() => {
                          setNotice(null);
                          setEditor(room);
                        }}
                        aria-label={`Editar ${room.name}`}
                      >
                        Editar
                      </button>
                      {room.status === "active" && (
                        <button
                          className="secondary"
                          onClick={() =>
                            openTransition({ room, action: "block" })
                          }
                        >
                          Bloquear<span className="sr-only"> {room.name}</span>
                        </button>
                      )}
                      {room.status === "blocked" && (
                        <>
                          <button
                            className="secondary"
                            onClick={() =>
                              openTransition({ room, action: "unblock" })
                            }
                          >
                            Desbloquear
                            <span className="sr-only"> {room.name}</span>
                          </button>
                          <button
                            className="text-button"
                            onClick={() =>
                              openTransition({ room, action: "block" })
                            }
                          >
                            Alterar motivo
                            <span className="sr-only"> {room.name}</span>
                          </button>
                        </>
                      )}
                      {room.status === "inactive" ? (
                        <button
                          className="secondary"
                          onClick={() =>
                            openTransition({ room, action: "reactivate" })
                          }
                        >
                          Reativar<span className="sr-only"> {room.name}</span>
                        </button>
                      ) : (
                        <button
                          className="text-button destructive"
                          onClick={() =>
                            openTransition({ room, action: "deactivate" })
                          }
                        >
                          Inativar<span className="sr-only"> {room.name}</span>
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <Empty title="Nenhuma sala encontrada">
                Altere os filtros ou cadastre a primeira sala.
              </Empty>
            )}
            <Pagination
              page={page}
              {...data.data}
              onChange={(p) => {
                const next = new URLSearchParams(params);
                next.set("page", String(p));
                setParams(next);
              }}
            />
          </>
        )
      )}
      {editor !== undefined && (
        <RoomEditor
          room={editor}
          onClose={(refresh = false) => {
            setEditor(undefined);
            if (refresh) data.reload();
          }}
          onSaved={() => {
            setEditor(undefined);
            setNotice({ text: "Sala salva. Os dados já estão atualizados." });
            data.reload();
          }}
        />
      )}
      {transition && (
        <RoomTransition
          {...transition}
          onClose={(refresh = false) => {
            setTransition(null);
            if (refresh) data.reload();
          }}
          onSaved={(room) => {
            setTransition(null);
            setNotice({
              text: `Estado atualizado. ${room.affected_reservations_count ?? 0} reservas confirmadas ainda não encerradas afetadas. As reservas foram preservadas.`,
              roomId: room.id,
            });
            data.reload();
          }}
        />
      )}
    </>
  );
}
export const auditTypes: Record<string, string> = {
  "login.success": "Entrada realizada",
  "login.denied": "Entrada negada",
  logout: "Saída da conta",
  "login.limit_unlocked": "Limite de entrada desbloqueado",
  "account.provisioned": "Conta provisionada",
  "room.created": "Sala criada",
  "room.updated": "Sala editada",
  "room.blocked": "Sala bloqueada",
  "room.unblocked": "Sala desbloqueada",
  "room.deactivated": "Sala inativada",
  "room.reactivated": "Sala reativada",
  "reservation.created": "Reserva criada",
  "reservation.cancelled": "Reserva cancelada",
  "operation.denied": "Operação negada",
};
function cursorTrail(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) &&
      parsed.length <= 100 &&
      parsed.every((item) => typeof item === "string" && /^\d*$/.test(item))
      ? parsed
      : [];
  } catch {
    return [];
  }
}
export function Audit() {
  const [params, setParams] = useSearchParams();
  const [type, setType] = useState(params.get("type") ?? "");
  const [actor, setActor] = useState(params.get("actor_id") ?? "");
  const [result, setResult] = useState(params.get("result") ?? "");
  const [from, setFrom] = useState<LocalInput>({
    value: params.get("from_local") ?? "",
    choice: params.get("from_choice") ?? "",
  });
  const [to, setTo] = useState<LocalInput>({
    value: params.get("to_local") ?? "",
    choice: params.get("to_choice") ?? "",
  });
  const [error, setError] = useState<unknown>(null);
  const previous = cursorTrail(params.get("trail"));
  const serialized = params.toString();
  useEffect(() => {
    const p = new URLSearchParams(serialized);
    setType(p.get("type") ?? "");
    setActor(p.get("actor_id") ?? "");
    setResult(p.get("result") ?? "");
    setFrom({
      value: p.get("from_local") ?? "",
      choice: p.get("from_choice") ?? "",
    });
    setTo({ value: p.get("to_local") ?? "", choice: p.get("to_choice") ?? "" });
    setError(null);
  }, [serialized]);
  const query = queryString({
    type: params.get("type") ?? "",
    actor_id: params.get("actor_id") ?? "",
    result: params.get("result") ?? "",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    cursor: params.get("cursor") ?? "",
  });
  const events = useQuery<AuditPage>(`/audit-events?${query}`);
  function apply(e: React.SubmitEvent) {
    e.preventDefault();
    const first = resolveLocal(from),
      last = resolveLocal(to);
    if (
      (from.value && !first) ||
      (to.value && !last) ||
      (first && last && first.epoch >= last.epoch)
    ) {
      setError(
        new Error("Confira o período e escolha o offset quando solicitado."),
      );
      return;
    }
    setError(null);
    setParams({
      type,
      actor_id: actor,
      result,
      from: first?.iso ?? "",
      to: last?.iso ?? "",
      from_local: from.value,
      to_local: to.value,
      from_choice: from.choice,
      to_choice: to.choice,
    });
    events.reload();
  }
  return (
    <>
      <PageHeading
        title="Histórico de atividades."
        description="Rastreabilidade com contexto e sem dados sensíveis."
        eyebrow="ADMINISTRAÇÃO"
      />
      <div className="message audit-note">
        Negações repetidas são agrupadas em janelas de 15 minutos. A contagem
        cobre o grupo inteiro, inclusive tentativas fora do período filtrado.
        Horários individuais intermediários não são retidos.
      </div>
      <form className="filters audit-filters" onSubmit={apply}>
        <label>
          Tipo de evento
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Todos</option>
            {Object.entries(auditTypes).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            {type && !auditTypes[type] && (
              <option value={type}>Tipo desconhecido: {type}</option>
            )}
          </select>
        </label>
        <label>
          ID do ator
          <input
            type="number"
            min="1"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          />
        </label>
        <label>
          Resultado
          <select value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="">Todos</option>
            <option value="success">Sucesso</option>
            <option value="denied">Negado</option>
          </select>
        </label>
        <DateTimeField
          label="Auditoria: a partir de"
          input={from}
          onChange={setFrom}
          required={false}
        />
        <DateTimeField
          label="Auditoria: até"
          input={to}
          onChange={setTo}
          required={false}
        />
        <button className="secondary">Filtrar eventos</button>
        <button
          className="text-button"
          type="button"
          onClick={() => {
            setError(null);
            setType("");
            setActor("");
            setResult("");
            setFrom({ value: "", choice: "" });
            setTo({ value: "", choice: "" });
            setParams({});
            events.reload();
          }}
        >
          Limpar filtros
        </button>
      </form>
      <p className="help">
        Horários em {browserZone()}. Eventos ordenados por ID; atualizar
        recarrega os grupos e suas contagens.
      </p>
      <ErrorPanel error={error || events.error} onRetry={events.reload} />
      {events.loading ? (
        <Loading label="Carregando auditoria…" />
      ) : (
        events.data && (
          <>
            {events.data.results.length ? (
              <div
                className="table-scroll"
                role="region"
                aria-label="Eventos de auditoria"
                tabIndex={0}
              >
                <table>
                  <caption className="sr-only">
                    Eventos de auditoria e contagens integrais de grupos
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Evento</th>
                      <th scope="col">Ator</th>
                      <th scope="col">Contagem</th>
                      <th scope="col">Primeiro → último</th>
                      <th scope="col">Recurso</th>
                      <th scope="col">Resultado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.data.results.map((event) => (
                      <tr key={event.id}>
                        <td>
                          <strong>
                            {auditTypes[event.type] ?? event.type}
                          </strong>
                          <small>{event.type}</small>
                          <small>ID {event.id}</small>
                          {Object.keys(event.metadata).length > 0 && (
                            <details>
                              <summary>Contexto do evento</summary>
                              <pre>
                                {JSON.stringify(event.metadata, null, 2)}
                              </pre>
                            </details>
                          )}
                        </td>
                        <td>
                          {event.actor?.name ?? "Não identificado"}
                          {event.actor && (
                            <>
                              <small>ID {event.actor.id}</small>
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => {
                                  const next = new URLSearchParams(params);
                                  next.set("actor_id", String(event.actor!.id));
                                  next.delete("cursor");
                                  next.delete("trail");
                                  setParams(next);
                                }}
                              >
                                Filtrar por {event.actor.name}
                              </button>
                            </>
                          )}
                        </td>
                        <td>
                          {event.count}
                          {event.count > 1 && <small>Grupo inteiro</small>}
                        </td>
                        <td>
                          {formatDate(event.first_at)}
                          <small>→ {formatDate(event.last_at)}</small>
                        </td>
                        <td>
                          {event.resource}
                          <small>{event.resource_id ?? "—"}</small>
                        </td>
                        <td>
                          <Status status={event.result} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="Nenhum evento neste período">
                Altere os filtros para consultar outras atividades.
              </Empty>
            )}
            <nav className="pagination" aria-label="Paginação de auditoria">
              <button
                className="secondary"
                disabled={!previous.length && !params.get("cursor")}
                onClick={() => {
                  const stack = [...previous];
                  const cursor = stack.pop() ?? "";
                  const next = new URLSearchParams(params);
                  next.set("cursor", cursor);
                  next.set("trail", JSON.stringify(stack));
                  setParams(next);
                }}
              >
                {previous.length ? "Anteriores" : "Voltar ao início"}
              </button>
              <button
                className="secondary"
                disabled={!events.data.has_more || !events.data.next_cursor}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set("cursor", String(events.data?.next_cursor ?? ""));
                  next.set(
                    "trail",
                    JSON.stringify([...previous, params.get("cursor") ?? ""]),
                  );
                  setParams(next);
                }}
              >
                Próximos eventos
              </button>
              <button
                className="text-button"
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete("cursor");
                  next.delete("trail");
                  setParams(next);
                  events.reload();
                }}
              >
                Atualizar auditoria
              </button>
            </nav>
          </>
        )
      )}
    </>
  );
}
