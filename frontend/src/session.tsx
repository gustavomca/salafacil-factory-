import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { Navigate, useLocation } from "react-router-dom";
import {
  clearCsrf,
  refreshCsrf,
  registerMutationGuard,
  request,
  ApiError,
} from "./api";
import { ErrorPanel, Loading, Mark, Notice } from "./ui";
import type { User } from "./types";
import { DraftProvider } from "./drafts";
interface SessionContext {
  user: User | null;
  expired: boolean;
  sessionMessage: string;
  checking: boolean;
  checkError: unknown;
  recheck: () => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}
const Context = createContext<SessionContext | null>(null);
export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error("SessionProvider is required");
  return value;
}
export function SessionProvider({ children }: { children: ReactNode }) {
  const [draftOwner, setDraftOwner] = useState<number | null>(null);
  const [draftReset, setDraftReset] = useState(0);
  const ownerRef = useRef<number | null>(null);
  const currentUser = useRef<User | null>(null);
  const generation = useRef(0);
  const verification = useRef<Promise<string> | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [expired, setExpired] = useState(false);
  const [sessionMessage, setSessionMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<unknown>(null);
  const expireSession = useCallback((changed = false) => {
    generation.current += 1;
    verification.current = null;
    returnFocus.current = null;
    currentUser.current = null;
    setUser(null);
    setExpired(true);
    setChecking(false);
    setCheckError(null);
    setSessionMessage(
      changed
        ? "A conta foi alterada em outra aba. Entre novamente para continuar. Os rascunhos da conta anterior foram descartados."
        : "Sua sessão expirou. Entre novamente para continuar. Seus rascunhos serão restaurados se você entrar na mesma conta.",
    );
    clearCsrf();
    if (changed) {
      ownerRef.current = null;
      setDraftOwner(null);
      setDraftReset((value) => value + 1);
    }
  }, []);
  const verifySession = useCallback(() => {
    if (verification.current) return verification.current;
    const expected = currentUser.current;
    if (!expected)
      return Promise.reject(
        new ApiError(
          401,
          "AUTH_REQUIRED",
          "Entre novamente antes de continuar.",
        ),
      );
    const epoch = generation.current;
    const stale = () => epoch !== generation.current;
    const staleError = () =>
      new ApiError(
        401,
        "SESSION_CHANGED",
        "A sessão mudou. Entre novamente antes de continuar.",
      );
    // Keep the original context across failures, not the temporary retry button.
    const active = document.activeElement;
    if (
      !returnFocus.current &&
      active instanceof HTMLElement &&
      active !== document.body &&
      active !== document.documentElement
    )
      returnFocus.current = active;
    setChecking(true);
    setCheckError(null);
    const pending = (async () => {
      // Check identity after receiving the new token; never apply an older response.
      const token = await refreshCsrf();
      if (stale()) throw staleError();
      const data = await request<{ user: User | null }>("/session/me");
      if (stale()) throw staleError();
      if (!data.user) {
        expireSession();
        throw staleError();
      }
      if (data.user.id !== expected.id) {
        expireSession(true);
        throw staleError();
      }
      currentUser.current = data.user;
      setUser(data.user);
      return token.csrf_token;
    })()
      .catch((err) => {
        if (!stale()) setCheckError(err);
        throw err;
      })
      .finally(() => {
        if (verification.current === pending) {
          verification.current = null;
          setChecking(false);
        }
      });
    verification.current = pending;
    return pending;
  }, [expireSession]);
  useEffect(() => registerMutationGuard(verifySession), [verifySession]);
  useEffect(() => {
    let alive = true;
    const epoch = ++generation.current;
    setLoading(true);
    setError(null);
    refreshCsrf()
      .then(() => request<{ user: User | null }>("/session/me"))
      .then((data) => {
        if (alive && epoch === generation.current) {
          currentUser.current = data.user;
          setUser(data.user);
          setDraftOwner(data.user?.id ?? null);
          ownerRef.current = data.user?.id ?? null;
        }
      })
      .catch((err) => {
        if (alive && epoch === generation.current) setError(err);
      })
      .finally(() => {
        if (alive && epoch === generation.current) setLoading(false);
      });
    return () => {
      alive = false;
      generation.current += 1;
    };
  }, [attempt]);
  useEffect(() => {
    const expire = () => expireSession();
    window.addEventListener("salafacil:session-expired", expire);
    return () =>
      window.removeEventListener("salafacil:session-expired", expire);
  }, [expireSession]);
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState !== "hidden" && currentUser.current)
        void verifySession().catch(() => {
          /* State renders the refusal; no mutation is retried. */
        });
    };
    window.addEventListener("focus", resync);
    document.addEventListener("visibilitychange", resync);
    return () => {
      window.removeEventListener("focus", resync);
      document.removeEventListener("visibilitychange", resync);
    };
  }, [verifySession]);
  useEffect(() => {
    if (!checking && !checkError && user && returnFocus.current) {
      const origin = returnFocus.current;
      returnFocus.current = null;
      if (document.activeElement !== document.body) return;
      // A dismissed modal no longer provides a usable return target.
      if (!origin.isConnected || origin.closest("dialog:not([open])"))
        (
          document.querySelector<HTMLElement>("main h1[tabindex]") ??
          document.querySelector<HTMLElement>("main[tabindex]")
        )?.focus({ preventScroll: true });
      else if (
        !origin.matches(":disabled") &&
        !origin.closest("[hidden], [inert]")
      )
        origin.focus({ preventScroll: true });
    }
  }, [checking, checkError, user]);
  async function login(email: string, password: string) {
    const epoch = ++generation.current;
    verification.current = null;
    setChecking(false);
    setCheckError(null);
    clearCsrf();
    const data = await request<{ user: User }>("/session/login", {
      method: "POST",
      body: { email, password },
    });
    clearCsrf();
    await refreshCsrf();
    if (epoch !== generation.current)
      throw new ApiError(
        401,
        "SESSION_CHANGED",
        "A sessão mudou. Entre novamente.",
      );
    if (ownerRef.current !== data.user.id) {
      setDraftOwner(data.user.id);
      ownerRef.current = data.user.id;
    }
    currentUser.current = data.user;
    setUser(data.user);
    setExpired(false);
    setSessionMessage("");
  }
  async function logout() {
    setDraftReset((value) => value + 1);
    await request<void>("/session/logout", { method: "POST", body: {} });
    generation.current += 1;
    verification.current = null;
    currentUser.current = null;
    returnFocus.current = null;
    clearCsrf();
    setUser(null);
    setDraftOwner(null);
    ownerRef.current = null;
    setExpired(false);
    setSessionMessage("");
    setChecking(false);
    setCheckError(null);
  }
  if (loading)
    return (
      <main className="startup">
        <Loading label="Restaurando sua sessão…" />
      </main>
    );
  if (error)
    return (
      <main className="startup">
        <h1>SalaFácil</h1>
        <ErrorPanel
          error={error}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      </main>
    );
  return (
    <Context.Provider
      value={{
        user,
        expired,
        sessionMessage,
        checking,
        checkError,
        recheck: () => {
          void verifySession().catch(() => {});
        },
        login,
        logout,
      }}
    >
      <DraftProvider key={draftOwner ?? "anonymous"} reset={draftReset}>
        {children}
      </DraftProvider>
    </Context.Provider>
  );
}
export function Protected({
  admin = false,
  children,
}: {
  admin?: boolean;
  children: ReactNode;
}) {
  const { user, checking, checkError, recheck } = useSession();
  const location = useLocation();
  if (!user)
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  if (admin && user.role !== "admin") return <Navigate to="/403" replace />;
  if (admin) return children;
  return (
    <>
      {checking && (
        <div className="session-check">
          <Loading label="Verificando sua sessão…" />
        </div>
      )}
      {checkError && (
        <div className="session-check">
          <ErrorPanel
            error={checkError}
            onRetry={recheck}
            retryLabel="Verificar sessão novamente"
          />
        </div>
      )}
      <div inert={checking || Boolean(checkError)} aria-busy={checking}>
        {children}
      </div>
    </>
  );
}
export function Login() {
  const { user, expired, sessionMessage, login } = useSession();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (user) {
    const state = location.state as { from?: string } | null;
    const from = state?.from;
    return (
      <Navigate
        to={
          from?.startsWith("/") && !from.startsWith("//") && from !== "/login"
            ? from
            : "/dashboard"
        }
        replace
      />
    );
  }
  async function submit(e: React.SubmitEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <div className="brand">
        <Mark />
        <strong>SalaFácil</strong>
      </div>
      <p className="eyebrow">MAIS ESPAÇO PARA BOAS IDEIAS</p>
      <h1 tabIndex={-1}>Bom ter você aqui.</h1>
      <p>Entre para encontrar seu próximo espaço.</p>
      {expired && (
        <Notice tone="error" focus={false}>
          {sessionMessage}
        </Notice>
      )}
      <ErrorPanel
        error={error}
        review={{ to: "/dashboard", label: "Consultar estado da sessão" }}
      />
      <form onSubmit={submit}>
        <label>
          E-mail
          <input
            type="email"
            autoComplete="username"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Senha
          <input
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={busy || (error instanceof ApiError && error.uncertain)}
        >
          {busy ? "Entrando…" : "Entrar"}
        </button>
      </form>
      <small>Use a conta fornecida pelo responsável do escritório.</small>
    </main>
  );
}
