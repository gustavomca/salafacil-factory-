import { syncClock } from "./time";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
    public uncertain = false,
    public retryAfter: string | null = null,
  ) {
    super(message);
  }
}
let csrf = "";
let csrfGeneration = 0;
let csrfInFlight: Promise<{ csrf_token: string; server_now: string }> | null =
  null;
let mutationGuard: (() => Promise<string>) | null = null;
/** A mounted session validates the displayed identity and returns its token snapshot. */
export function registerMutationGuard(guard: () => Promise<string>) {
  mutationGuard = guard;
  return () => {
    if (mutationGuard === guard) mutationGuard = null;
  };
}
export function clearCsrf() {
  csrf = "";
  csrfGeneration += 1;
  csrfInFlight = null;
}
export function refreshCsrf() {
  if (csrfInFlight) return csrfInFlight;
  const generation = csrfGeneration;
  const pending = request<{ csrf_token: string; server_now: string }>(
    "/session/csrf",
  )
    .then((data) => {
      if (generation === csrfGeneration) csrf = data.csrf_token;
      return data;
    })
    .finally(() => {
      if (csrfInFlight === pending) csrfInFlight = null;
    });
  csrfInFlight = pending;
  return pending;
}
export async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const mutation = method !== "GET";
  let mutationToken = "";
  if (mutation) {
    mutationToken =
      mutationGuard && path !== "/session/login"
        ? await mutationGuard()
        : csrf || (await refreshCsrf()).csrf_token;
  }
  const sent = performance.now();
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(mutation
          ? { "Content-Type": "application/json", "X-CSRFToken": mutationToken }
          : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      mutation
        ? "Não foi possível confirmar o resultado. A operação pode ter sido concluída. Consulte os registros antes de tentar novamente."
        : "Não foi possível conectar ao servidor. Tente carregar novamente.",
      {},
      mutation,
    );
  }
  if (response.status === 204) return undefined as T;
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      "INVALID_RESPONSE",
      mutation
        ? "O servidor não confirmou o resultado. Consulte os registros antes de tentar novamente."
        : "O servidor enviou uma resposta inválida.",
      {},
      mutation,
    );
  }
  if (
    typeof data === "object" &&
    data !== null &&
    "server_now" in data &&
    typeof data.server_now === "string"
  )
    syncClock(data.server_now, sent, performance.now());
  if (!response.ok) {
    const envelope = data as {
      error?: {
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
      };
    };
    const error =
      typeof data === "object" && data !== null ? envelope.error : undefined;
    const code = error?.code ?? "HTTP_ERROR";
    if (response.status === 401 && code !== "INVALID_CREDENTIALS")
      window.dispatchEvent(new Event("salafacil:session-expired"));
    if (code === "CSRF_FAILED") clearCsrf();
    throw new ApiError(
      response.status,
      code,
      error?.message ?? "Não foi possível concluir a solicitação.",
      error?.details ?? {},
      mutation && response.status >= 500 && code !== "RETRY_LATER",
      response.headers.get("Retry-After"),
    );
  }
  return data as T;
}
export function queryString(
  values: Record<string, string | number | undefined>,
) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(values))
    if (v !== undefined && v !== "") p.set(k, String(v));
  return p.toString();
}
export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Ocorreu um erro inesperado.";
}
