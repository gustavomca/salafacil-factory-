import { useEffect, useRef, type ReactNode, type AriaAttributes } from "react";
import { Link } from "react-router-dom";
import { useAnnouncement } from "./live";
import { ApiError, errorMessage } from "./api";
import {
  browserZone,
  localCandidates,
  offsetLabel,
  type LocalCandidate,
} from "./time";
export function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg width="25" height="27" viewBox="0 0 25 27" fill="none">
        <path
          d="M4 24V4h14v20M8 24V9h14v15M1 24h23M13 14v7M18 16h1"
          stroke="currentColor"
          strokeWidth="1.7"
        />
      </svg>
    </span>
  );
}
export function Loading({ label = "Carregando…" }: { label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const persistent = useAnnouncement(ref);
  return (
    <div
      ref={ref}
      className="empty loading"
      role={persistent ? undefined : "status"}
      aria-busy="true"
    >
      {label}
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-symbol" aria-hidden="true">
        ▦
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
const fieldLabels: Record<string, string> = {
  title: "Título da reunião",
  description: "Descrição",
  starts_at: "Início",
  ends_at: "Término",
  participants: "Participantes",
  name: "Nome da sala",
  capacity: "Capacidade",
  location: "Localização",
  reason: "Motivo",
  type: "Tipo de evento",
  actor_id: "ID do ator",
  result: "Resultado",
  from: "Início do período",
  to: "Fim do período",
  page: "Página",
  cursor: "Página da auditoria",
  room_id: "Sala",
  resources: "Recursos",
  status: "Estado",
};
export function isPageError(error: unknown) {
  return (
    error instanceof ApiError &&
    error.status === 400 &&
    Boolean(error.details.page)
  );
}
export function ErrorPanel({
  error,
  onRetry,
  retryLabel = "Tentar carregar novamente",
  review,
  children,
}: {
  error: unknown;
  onRetry?: () => void;
  retryLabel?: string;
  review?: { to: string; label: string };
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const api = error instanceof ApiError ? error : null;
  const key = error
    ? `${api?.code ?? ""}:${errorMessage(error)}:${JSON.stringify(api?.details ?? {})}`
    : "";
  useEffect(() => {
    if (key) ref.current?.focus();
  }, [key]);
  if (!error) return null;
  const conflictTitles: Record<string, string> = {
    ROOM_UNAVAILABLE: "A sala não está disponível para esta reserva.",
    ROOM_CAPACITY_CONFLICT: "A capacidade da sala não comporta estas reservas.",
    INVALID_ROOM_STATE: "O estado da sala mudou.",
  };
  const title = api?.uncertain
    ? "Não foi possível confirmar o resultado."
    : api?.status === 409
      ? (conflictTitles[api.code] ?? "Os dados mudaram. Revise a solicitação.")
      : api?.status === 403
        ? "Acesso não autorizado."
        : api?.status === 404
          ? "Registro não encontrado."
          : api?.status === 429
            ? "Aguarde antes de tentar novamente."
            : "Confira esta solicitação.";
  const seconds =
    api?.retryAfter && /^\d+$/.test(api.retryAfter)
      ? Number(api.retryAfter)
      : null;
  return (
    <div className="message error" role="alert" tabIndex={-1} ref={ref}>
      <strong>{title}</strong>
      <p>{errorMessage(error)}</p>
      {api && Object.keys(api.details).length > 0 && (
        <ul className="validation-summary">
          {Object.entries(api.details).map(([name, value]) => (
            <li key={name}>
              {fieldLabels[name] ?? name}:{" "}
              {Array.isArray(value)
                ? value.map(String).join(" ")
                : String(value)}
            </li>
          ))}
        </ul>
      )}
      {api?.retryAfter && (
        <p>
          {seconds !== null
            ? `Tente novamente em aproximadamente ${seconds} segundos (${Math.ceil(seconds / 60)} min).`
            : `Tente novamente após ${api.retryAfter}.`}
        </p>
      )}
      {api?.code === "CSRF_FAILED" && (
        <p>
          A proteção da sessão será renovada. Revise os dados e envie novamente.
        </p>
      )}
      {onRetry && !api?.uncertain && (
        <button type="button" className="text-button" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
      {api?.uncertain && (
        <p>
          O envio está bloqueado para evitar duplicação.{" "}
          {review && (
            <Link to={review.to} reloadDocument>
              {review.label}
            </Link>
          )}
        </p>
      )}
      {children}
    </div>
  );
}
export function Notice({
  children,
  focus = true,
  tone = "success",
}: {
  children: ReactNode;
  focus?: boolean;
  tone?: "success" | "error";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const persistent = useAnnouncement(ref, focus);
  return (
    <div
      className={`message ${tone}`}
      role={persistent ? "note" : "status"}
      aria-label={focus ? "Confirmação" : undefined}
      tabIndex={focus ? -1 : undefined}
      ref={ref}
    >
      {children}
    </div>
  );
}
export function FieldError({ error, name }: { error: unknown; name: string }) {
  if (!(error instanceof ApiError)) return null;
  const value = error.details[name];
  if (!value) return null;
  const message = Array.isArray(value)
    ? value.map(String).join(" ")
    : String(value);
  return (
    <span id={`error-${name}`} className="field-error">
      {message}
    </span>
  );
}
export function fieldErrorProps(error: unknown, name: string) {
  return error instanceof ApiError && Boolean(error.details[name])
    ? { "aria-invalid": true as const, "aria-describedby": `error-${name}` }
    : {};
}
export function Pagination({
  page,
  count,
  next,
  previous,
  onChange,
}: {
  page: number;
  count: number;
  next: string | null;
  previous: string | null;
  onChange: (page: number) => void;
}) {
  return (
    <nav className="pagination" aria-label="Paginação">
      <span>
        {count} registros · página {page}
      </span>
      <button
        className="secondary"
        disabled={!previous}
        onClick={() => onChange(page - 1)}
      >
        Anterior
      </button>
      <button
        className="secondary"
        disabled={!next}
        onClick={() => onChange(page + 1)}
      >
        Próxima
      </button>
    </nav>
  );
}
export function Status({ status }: { status: string }) {
  const labels: Record<string, string> = {
    active: "Ativa",
    blocked: "Bloqueada",
    inactive: "Inativa",
    confirmed: "Confirmada",
    cancelled: "Cancelada",
    success: "Sucesso",
    denied: "Negado",
  };
  return (
    <span
      className={`pill ${["blocked", "denied"].includes(status) ? "warning" : ["inactive", "cancelled"].includes(status) ? "neutral" : ""}`}
    >
      {labels[status] ?? status}
    </span>
  );
}
export function Modal({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const origin = useRef(document.activeElement);
  useEffect(() => {
    const previous = origin.current;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("[data-modal-autofocus]")?.focus();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      className="modal"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="modal-inner">{children}</div>
    </dialog>
  );
}
export interface LocalInput {
  value: string;
  choice: string;
}
export function resolveLocal(
  input: LocalInput,
  zone = browserZone(),
): LocalCandidate | undefined {
  const candidates = localCandidates(input.value, zone);
  return candidates.length === 1
    ? candidates[0]
    : candidates.find((c) => String(c.epoch) === input.choice);
}
export function DateTimeField({
  label,
  input,
  onChange,
  required = true,
  zone = browserZone(),
  error,
  inputAttributes,
}: {
  label: string;
  input: LocalInput;
  onChange: (value: LocalInput) => void;
  required?: boolean;
  zone?: string;
  error?: ReactNode;
  inputAttributes?: AriaAttributes;
}) {
  const candidates = localCandidates(input.value, zone);
  return (
    <div className="datetime-field">
      <label>
        {label}
        <input
          {...inputAttributes}
          type="datetime-local"
          required={required}
          value={input.value}
          onChange={(e) => onChange({ value: e.target.value, choice: "" })}
        />
      </label>
      {input.value && candidates.length === 0 && (
        <p className="field-error" role="alert">
          Este horário não existe neste fuso. Escolha outro horário.
        </p>
      )}
      {candidates.length > 1 && (
        <label className="fold">
          {label}: escolha o offset
          <select
            required
            value={input.choice}
            onChange={(e) => onChange({ ...input, choice: e.target.value })}
          >
            <option value="">Horário ambíguo — selecione</option>
            {candidates.map((c) => (
              <option key={c.epoch} value={String(c.epoch)}>
                {offsetLabel(c.offset)} · {new Date(c.epoch).toISOString()}
              </option>
            ))}
          </select>
        </label>
      )}
      {error}
    </div>
  );
}
export function PageHeading({
  eyebrow = "SUA ORGANIZAÇÃO, EM UM SÓ LUGAR",
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1 tabIndex={-1}>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </section>
  );
}
