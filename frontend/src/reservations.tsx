import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ApiError, queryString, request } from "./api";
import { useQuery } from "./hooks";
import {
  browserZone,
  formatDate,
  intervalLabel,
  localValue,
  time,
} from "./time";
import {
  DateTimeField,
  Empty,
  ErrorPanel,
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
import type { Page, Reservation } from "./types";
export function CancelDialog({
  reservation,
  onClose,
  onCancelled,
  reviewHref = "/reservations",
}: {
  reservation: Reservation;
  reviewHref?: string;
  onClose: () => void;
  onCancelled: (value: Reservation) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function cancel() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await request<Reservation>(
        `/reservations/${reservation.id}/cancel`,
        { method: "POST", body: {} },
      );
      onCancelled(result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      label="Cancelar reserva"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <h2>Cancelar este encontro?</h2>
      <p>O horário ficará disponível. A reserva continuará no seu histórico.</p>
      <div className="summary">
        <strong>{reservation.title}</strong>
        <span>{reservation.room.name}</span>
        <span>{intervalLabel(reservation.starts_at, reservation.ends_at)}</span>
        <span>
          {reservation.participants} participantes · {browserZone()}
        </span>
      </div>
      <ErrorPanel
        error={error}
        review={{ to: reviewHref, label: "Consultar estado da reserva" }}
      />
      <div className="form-footer">
        <button
          className="secondary"
          autoFocus
          data-modal-autofocus
          disabled={busy}
          onClick={onClose}
        >
          Manter reserva
        </button>
        <button
          className="danger"
          disabled={busy || (error instanceof ApiError && error.uncertain)}
          onClick={cancel}
        >
          {busy ? "Cancelando…" : "Cancelar reserva"}
        </button>
      </div>
    </Modal>
  );
}
export function BookingRows({
  items,
  onCancel,
  admin = false,
  emptyKind = "upcoming",
}: {
  items: Reservation[];
  onCancel: (value: Reservation) => void;
  admin?: boolean;
  emptyKind?: "today" | "upcoming" | "past" | "cancelled" | "all" | "filtered";
}) {
  if (!items.length) {
    const empty = {
      today: ["Nenhuma reserva neste dia", "Sua agenda está livre neste dia."],
      upcoming: [
        "Nenhuma próxima reserva",
        "Encontre um horário para seu próximo encontro.",
      ],
      past: ["Nenhuma reserva passada", "Reservas encerradas aparecerão aqui."],
      cancelled: [
        "Nenhuma reserva cancelada",
        "Os cancelamentos serão mantidos neste histórico.",
      ],
      all: [
        "Nenhuma reserva encontrada",
        admin
          ? "As reservas do escritório aparecerão aqui."
          : "Seus encontros aparecerão aqui.",
      ],
      filtered: [
        "Nenhuma reserva para estes filtros",
        "Altere ou limpe os filtros para consultar outros encontros.",
      ],
    }[emptyKind];
    return <Empty title={empty[0]}>{empty[1]}</Empty>;
  }
  return (
    <div className="booking-list">
      {items.map((item) => (
        <article
          className={`booking ${item.status === "cancelled" ? "is-cancelled" : ""}`}
          key={item.id}
        >
          <div className="booking-time">
            <strong>{time(item.starts_at)}</strong>
            <span>{time(item.ends_at)}</span>
          </div>
          <div className="booking-main">
            <h3>
              <Link to={`${admin ? "/admin" : ""}/reservations/${item.id}`}>
                {item.title}
              </Link>
            </h3>
            <p>
              {item.room.name} · {item.participants} pessoas ·{" "}
              {formatDate(item.starts_at, {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })}
              {localValue(Date.parse(item.starts_at)).slice(0, 10) !==
                localValue(Date.parse(item.ends_at)).slice(0, 10) &&
                ` → ${formatDate(item.ends_at, { day: "2-digit", month: "short" })}`}
            </p>
            {admin && item.user && (
              <p>
                {item.user.name} · {item.user.email}
              </p>
            )}
            {item.room.status !== "active" && (
              <p className="room-warning">
                Sala {item.room.status === "blocked" ? "bloqueada" : "inativa"}
                {item.room.blocked_reason
                  ? ` · ${item.room.blocked_reason}`
                  : ""}
                . Sua reserva foi preservada.
              </p>
            )}
            {item.cancelled_at && (
              <p>Cancelada em {formatDate(item.cancelled_at)}</p>
            )}
          </div>
          <Status status={item.status} />
          {item.status === "confirmed" && (
            <button
              className="text-button cancel-button"
              onClick={() => onCancel(item)}
            >
              Cancelar<span className="sr-only"> {item.title}</span>
            </button>
          )}
        </article>
      ))}
    </div>
  );
}
export function Reservations({ admin = false }: { admin?: boolean }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get("view") ?? (admin ? "all" : "upcoming");
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [cancel, setCancel] = useState<Reservation | null>(null);
  const [notice, setNotice] = useState("");
  const [from, setFrom] = useState<LocalInput>({
    value: params.get("from_local") ?? "",
    choice: params.get("from_choice") ?? "",
  });
  const [to, setTo] = useState<LocalInput>({
    value: params.get("to_local") ?? "",
    choice: params.get("to_choice") ?? "",
  });
  const [roomId, setRoomId] = useState(params.get("room_id") ?? "");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [filterError, setFilterError] = useState("");
  const serialized = params.toString();
  useEffect(() => {
    const p = new URLSearchParams(serialized);
    setFrom({
      value: p.get("from_local") ?? "",
      choice: p.get("from_choice") ?? "",
    });
    setTo({ value: p.get("to_local") ?? "", choice: p.get("to_choice") ?? "" });
    setRoomId(p.get("room_id") ?? "");
    setStatus(p.get("status") ?? "");
    setFilterError("");
  }, [serialized]);
  const query = queryString({
    scope: admin ? "all" : "mine",
    page,
    page_size: 20,
    room_id: params.get("room_id") ?? "",
    status:
      tab === "cancelled"
        ? "cancelled"
        : tab === "all"
          ? (params.get("status") ?? "")
          : "confirmed",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    not_ended:
      tab === "upcoming"
        ? "true"
        : tab === "past"
          ? "false"
          : (params.get("not_ended") ?? ""),
  });
  const result = useQuery<Page<Reservation>>(`/reservations?${query}`);
  function update(values: Record<string, string>) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(values)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    setParams(p);
  }
  function apply(e: React.SubmitEvent) {
    e.preventDefault();
    const start = resolveLocal(from),
      end = resolveLocal(to);
    if ((from.value && !start) || (to.value && !end)) {
      setFilterError(
        "Confira os horários e escolha o offset quando solicitado.",
      );
      return;
    }
    if (start && end && end.epoch <= start.epoch) {
      setFilterError("O fim do filtro deve ser posterior ao início.");
      return;
    }
    setFilterError("");
    update({
      from: start?.iso ?? "",
      to: end?.iso ?? "",
      from_local: from.value,
      to_local: to.value,
      from_choice: from.choice,
      to_choice: to.choice,
      room_id: roomId,
      status,
      page: "1",
    });
    result.reload();
  }
  const items = result.data?.results ?? [];
  return (
    <>
      <PageHeading
        title={admin ? "Todas as reservas" : "Minhas reservas"}
        eyebrow={admin ? "ADMINISTRAÇÃO" : "SUA ORGANIZAÇÃO, EM UM SÓ LUGAR"}
        description={
          admin
            ? "Consulte e trate os encontros de todo o escritório."
            : "Consulte seus encontros e mantenha o histórico à mão."
        }
      >
        <Link className="primary" to="/rooms">
          + Nova reserva
        </Link>
      </PageHeading>
      {notice && <Notice>{notice}</Notice>}
      <div className="tabs" role="group" aria-label="Período das reservas">
        {(admin
          ? [
              ["all", "Todas"],
              ["upcoming", "Próximas"],
              ["past", "Passadas"],
              ["cancelled", "Canceladas"],
            ]
          : [
              ["all", "Todas"],
              ["upcoming", "Próximas"],
              ["past", "Passadas"],
              ["cancelled", "Canceladas"],
            ]
        ).map(([id, label]) => (
          <button
            key={id}
            aria-pressed={tab === id}
            onClick={() => update({ view: id, page: "1", not_ended: "" })}
          >
            {label}
          </button>
        ))}
      </div>
      <form className="filters" onSubmit={apply}>
        <DateTimeField
          label="Período: a partir de"
          input={from}
          onChange={setFrom}
          required={false}
        />
        <DateTimeField
          label="Período: até"
          input={to}
          onChange={setTo}
          required={false}
        />
        <label>
          ID da sala
          <input
            type="number"
            min="1"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          />
        </label>
        {admin && tab === "all" && (
          <label>
            Estado da reserva
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Todos</option>
              <option value="confirmed">Confirmada</option>
              <option value="cancelled">Cancelada</option>
            </select>
          </label>
        )}
        <button className="secondary">Aplicar filtros</button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setFilterError("");
            setFrom({ value: "", choice: "" });
            setTo({ value: "", choice: "" });
            setRoomId("");
            setStatus("");
            setParams({ view: tab });
          }}
        >
          Limpar filtros
        </button>
      </form>
      <p className="help">
        Horários em {browserZone()}. O período inclui reservas que o atravessam.
        Próximas inclui reservas em andamento.
      </p>
      {filterError && <ErrorPanel error={filterError} />}
      <ErrorPanel
        error={result.error}
        onRetry={
          isPageError(result.error)
            ? () => update({ page: "1" })
            : result.reload
        }
        retryLabel={
          isPageError(result.error) ? "Voltar à primeira página" : undefined
        }
      />
      {result.loading ? (
        <Loading label="Carregando reservas…" />
      ) : (
        result.data && (
          <>
            <BookingRows
              items={items}
              admin={admin}
              onCancel={(reservation) => {
                setNotice("");
                setCancel(reservation);
              }}
              emptyKind={
                params.get("from") || params.get("to") || params.get("room_id")
                  ? "filtered"
                  : tab === "past" || tab === "cancelled" || tab === "all"
                    ? tab
                    : "upcoming"
              }
            />
            <Pagination
              page={page}
              {...result.data}
              onChange={(p) => update({ page: String(p) })}
            />
          </>
        )
      )}
      {cancel && (
        <CancelDialog
          reservation={cancel}
          reviewHref={`${admin ? "/admin" : ""}/reservations/${cancel.id}`}
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
export function ReservationDetail({ admin = false }: { admin?: boolean }) {
  const { id } = useParams();
  const result = useQuery<Reservation>(
    `/reservations/${encodeURIComponent(id ?? "")}${admin ? "?scope=all" : ""}`,
  );
  const [cancel, setCancel] = useState(false);
  const [notice, setNotice] = useState("");
  return (
    <>
      <PageHeading
        title="Detalhes da reserva"
        description="Consulte todos os dados do seu encontro."
      />
      <Link
        className="text-button"
        to={admin ? "/admin/reservations" : "/reservations"}
      >
        ← Voltar às reservas
      </Link>
      {notice && <Notice>{notice}</Notice>}
      <ErrorPanel error={result.error} onRetry={result.reload} />
      {result.loading ? (
        <Loading />
      ) : (
        result.data && (
          <article className="detail-card">
            <div className="section-title">
              <h2>{result.data.title}</h2>
              <Status status={result.data.status} />
            </div>
            <dl>
              <dt>Sala</dt>
              <dd>
                {result.data.room.name} · {result.data.room.location}
              </dd>
              <dt>Início</dt>
              <dd>{formatDate(result.data.starts_at)}</dd>
              <dt>Término</dt>
              <dd>{formatDate(result.data.ends_at)}</dd>
              <dt>Fuso</dt>
              <dd>{browserZone()}</dd>
              <dt>Participantes</dt>
              <dd>{result.data.participants}</dd>
              <dt>Descrição</dt>
              <dd className="preserve-lines">
                {result.data.description || "Sem descrição."}
              </dd>
              <dt>Criada em</dt>
              <dd>{formatDate(result.data.created_at)}</dd>
              {result.data.cancelled_at && (
                <>
                  <dt>Cancelada em</dt>
                  <dd>{formatDate(result.data.cancelled_at)}</dd>
                </>
              )}
              {admin && result.data.user && (
                <>
                  <dt>Responsável</dt>
                  <dd>
                    {result.data.user.name} · {result.data.user.email}
                  </dd>
                </>
              )}
            </dl>
            {result.data.room.status !== "active" && (
              <div className="message error">
                A sala está{" "}
                {result.data.room.status === "blocked"
                  ? "bloqueada"
                  : "inativa"}
                . {result.data.room.blocked_reason} A reserva foi preservada.
              </div>
            )}
            {result.data.status === "confirmed" && (
              <button
                className="danger"
                onClick={() => {
                  setNotice("");
                  setCancel(true);
                }}
              >
                Cancelar reserva
              </button>
            )}
          </article>
        )
      )}
      {cancel && result.data && (
        <CancelDialog
          reservation={result.data}
          reviewHref={`${admin ? "/admin" : ""}/reservations/${result.data.id}`}
          onClose={() => setCancel(false)}
          onCancelled={(value) => {
            result.setData({ ...value, user: value.user ?? result.data?.user });
            setCancel(false);
            setNotice("Reserva cancelada. O histórico foi preservado.");
          }}
        />
      )}
    </>
  );
}
