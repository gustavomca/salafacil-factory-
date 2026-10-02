import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { ApiError } from "./api";
import { AdminRooms, Audit } from "./admin";
import { DashboardPage, RoomsPage } from "./rooms";
import { ReservationDetail, Reservations } from "./reservations";
import { Login, Protected, SessionProvider, useSession } from "./session";
import { estimatedNow, formatDate } from "./time";
import { useTick } from "./hooks";
import { ErrorPanel, Mark, PageHeading } from "./ui";
import { LiveProvider } from "./live";
function RouteFocus() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = `SalaFácil · ${pathname.startsWith("/admin") ? "Administração" : "Sua agenda, em dia"}`;
    document.querySelector<HTMLElement>("main h1")?.focus();
    window.scrollTo?.(0, 0);
  }, [pathname]);
  return null;
}
function Layout() {
  useTick();
  const { user, logout } = useSession();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const location = useLocation();
  const items = [
    ["/dashboard", "▦", "Meu dia"],
    ["/rooms", "▥", "Salas e horários"],
    ["/reservations", "▤", "Minhas reservas"],
  ];
  const adminItems = [
    ["/admin/rooms", "Gerenciar salas"],
    ["/admin/reservations", "Todas as reservas"],
    ["/admin/audit", "Auditoria"],
  ];
  async function leave() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await logout();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <a className="skip-link" href="#main">
        Pular para o conteúdo
      </a>
      <header className={`topnav ${user?.role === "admin" ? "admin-nav" : ""}`}>
        <Link
          className="brand"
          to="/dashboard"
          aria-label="SalaFácil — Meu dia"
        >
          <Mark />
          <strong>SalaFácil</strong>
        </Link>
        <nav aria-label="Principal">
          {items.map(([url, icon, label]) => (
            <NavLink
              to={url}
              key={url}
              end={url === "/reservations"}
              className={({ isActive }) =>
                `navitem ${isActive ? "selected" : ""}`
              }
            >
              <span aria-hidden="true">{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="profile">
          <span className="avatar" aria-hidden="true">
            {user?.name
              .split(" ")
              .map((x) => x[0])
              .slice(0, 2)
              .join("")}
          </span>
          <span className="profile-name">
            <strong>{user?.name}</strong>
            <small>{user?.role === "admin" ? "Administrador" : "Membro"}</small>
          </span>
          <button
            className="icon-button"
            aria-label="Sair da conta"
            title="Sair da conta"
            disabled={busy || (error instanceof ApiError && error.uncertain)}
            onClick={leave}
          >
            ⇥
          </button>
        </div>
        {user?.role === "admin" && (
          <nav className="admin-navigation" aria-label="Administração">
            <span>ADMINISTRAÇÃO</span>
            {adminItems.map(([url, label]) => (
              <NavLink
                key={url}
                to={url}
                className={({ isActive }) =>
                  `navitem ${isActive ? "selected" : ""}`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
        )}
      </header>
      <main className="main" id="main" tabIndex={-1}>
        <div className="topline">
          <span>
            Escritório principal <span className="slash">/</span>{" "}
            {location.pathname.startsWith("/admin")
              ? "Administração"
              : (items.find(([url]) =>
                  location.pathname.startsWith(url),
                )?.[2] ?? "Sua agenda")}
          </span>
          <span>
            {estimatedNow() !== null &&
              formatDate(estimatedNow()!, {
                weekday: "short",
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
          </span>
        </div>
        <ErrorPanel
          error={error}
          review={{ to: "/dashboard", label: "Consultar estado da sessão" }}
        ></ErrorPanel>
        <Outlet />
        <footer className="footer">
          <span>SalaFácil · Mais espaço para boas ideias.</span>
          <span>Horários no seu fuso local</span>
        </footer>
      </main>
    </>
  );
}
function StatusPage({ code }: { code: 403 | 404 }) {
  return (
    <>
      <PageHeading
        title={
          code === 403
            ? "Este espaço é restrito."
            : "Não encontramos esta página."
        }
        eyebrow={String(code)}
        description={
          code === 403
            ? "Sua conta não tem permissão para acessar esta área."
            : "Confira o endereço ou volte para sua agenda."
        }
      />
      <Link className="primary" to="/dashboard">
        Voltar ao meu dia
      </Link>
    </>
  );
}
export default function App() {
  return (
    <LiveProvider>
      <SessionProvider>
        <RouteFocus />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <Protected>
                <Layout />
              </Protected>
            }
          >
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/rooms" element={<RoomsPage />} />
            <Route path="/reservations/new" element={<RoomsPage booking />} />
            <Route path="/reservations" element={<Reservations />} />
            <Route path="/reservations/:id" element={<ReservationDetail />} />
            <Route
              path="/admin/rooms"
              element={
                <Protected admin>
                  <AdminRooms />
                </Protected>
              }
            />
            <Route
              path="/admin/reservations"
              element={
                <Protected admin>
                  <Reservations admin />
                </Protected>
              }
            />
            <Route
              path="/admin/reservations/:id"
              element={
                <Protected admin>
                  <ReservationDetail admin />
                </Protected>
              }
            />
            <Route
              path="/admin/audit"
              element={
                <Protected admin>
                  <Audit />
                </Protected>
              }
            />
            <Route path="/403" element={<StatusPage code={403} />} />
            <Route path="*" element={<StatusPage code={404} />} />
          </Route>
        </Routes>
      </SessionProvider>
    </LiveProvider>
  );
}
