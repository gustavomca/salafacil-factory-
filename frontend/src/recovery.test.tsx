import { useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import App from "./App";
import { useTick } from "./hooks";
import * as api from "./api";
import { AdminRooms, Audit } from "./admin";
import {
  Reservations,
  ReservationDetail,
  CancelDialog,
  BookingRows,
} from "./reservations";
import { ErrorPanel, Loading, Notice } from "./ui";
import { LiveProvider } from "./live";
import { localValue, syncClock, estimatedNow } from "./time";
import type { Room, Reservation, User } from "./types";
const room: Room = {
  id: 1,
  name: "Sala Cedro",
  capacity: 8,
  description: "Sala de encontros",
  location: "1º andar",
  resources: ["whiteboard"],
  status: "active",
  blocked_reason: "",
  created_at: "2030-01-01T09:00:00Z",
  updated_at: "2030-01-01T09:00:00Z",
};
const member: User = {
  id: 1,
  name: "Membro",
  email: "member@example.test",
  role: "member",
};
const admin: User = {
  id: 2,
  name: "Admin",
  email: "admin@example.test",
  role: "admin",
};
const reservation: Reservation = {
  id: "f29cd7e6-c4ec-403f-8b82-5854e33bab88",
  room,
  title: "Planejamento",
  description: "Pauta",
  starts_at: "2030-01-01T11:00:00Z",
  ends_at: "2030-01-01T12:00:00Z",
  participants: 4,
  status: "confirmed",
  created_at: "2030-01-01T10:00:00Z",
  cancelled_at: null,
};
const page = (results: unknown[] = []) => ({
  count: results.length,
  next: null,
  previous: null,
  results,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  api.clearCsrf();
  syncClock("2030-01-01T10:00:00Z", performance.now(), performance.now());
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
function server(initial = member) {
  let account: User | null = initial;
  let nextLogin = initial;
  let expireNext = false;
  let clock = "2030-01-01T10:00:00Z";
  let identityGate: Promise<void> | null = null;
  let reservationGate: Promise<void> | null = null;
  let identityFailure = false;
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, options) => {
      const url = String(input),
        method = options?.method ?? "GET";
      if (url === "/api/session/csrf")
        return json({
          csrf_token: `masked-${account?.id ?? 0}`,
          server_now: clock,
        });
      if (url === "/api/session/me") {
        if (identityFailure)
          return json(
            {
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "Não foi possível verificar a conta.",
                details: {},
              },
            },
            503,
          );
        const observed = account;
        if (identityGate) await identityGate;
        return json({ user: observed });
      }
      if (url === "/api/session/login") {
        account = nextLogin;
        return json({ user: account });
      }
      if (url === "/api/session/logout") {
        account = null;
        return new Response(null, { status: 204 });
      }
      if (expireNext && method !== "GET") {
        expireNext = false;
        account = null;
        return json(
          {
            error: {
              code: "AUTH_REQUIRED",
              message: "Entre novamente",
              details: {},
            },
          },
          401,
        );
      }
      if (url === "/api/reservations" && method === "POST") {
        if (reservationGate) await reservationGate;
        return json(
          {
            ...reservation,
            ...JSON.parse(String(options?.body)),
            user: account,
          },
          201,
        );
      }
      if (url.startsWith("/api/availability")) return json(page([room]));
      if (url === "/api/rooms/1") return json(room);
      if (url.startsWith("/api/rooms") && method === "GET")
        return json(page([room]));
      if (url.startsWith("/api/reservations") && method === "GET")
        return json(page());
      if (url.startsWith("/api/dashboard"))
        return json({
          date: "2030-01-01",
          tz: "UTC",
          today: [],
          upcoming: [],
          counts: { my_today: 0, my_upcoming: 0, available_now: 1 },
        });
      throw new Error(`Unexpected ${method} ${url}`);
    });
  return {
    fetch,
    failIdentity: (value: boolean) => {
      identityFailure = value;
    },
    switchAccount: (value: User | null) => {
      account = value;
    },
    pauseIdentity: () => {
      let release = () => {};
      identityGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        release();
        identityGate = null;
      };
    },
    pauseReservation: () => {
      let release = () => {};
      reservationGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        release();
        reservationGate = null;
      };
    },
    expire: () => {
      expireNext = true;
    },
    loginAs: (value: User) => {
      nextLogin = value;
    },
    setClock: (value: string) => {
      clock = value;
    },
  };
}
async function login(account = member) {
  const actor = userEvent.setup();
  await actor.type(await screen.findByLabelText("E-mail"), account.email);
  await actor.type(screen.getByLabelText("Senha"), "test-password");
  await actor.click(screen.getByRole("button", { name: "Entrar" }));
}
const bookingPath = () =>
  `/reservations/new?${new URLSearchParams({ room_id: "1", start: localValue(Date.parse(reservation.starts_at)), end: localValue(Date.parse(reservation.ends_at)), people: "4" })}`;
describe("O4-C reservation intention and session identity", () => {
  it("starts a new draft for an explicitly different SPA booking interval and people", async () => {
    const backend = server();
    render(
      <MemoryRouter initialEntries={[bookingPath()]}>
        <App />
      </MemoryRouter>,
    );
    await userEvent.type(
      await screen.findByLabelText("Título da reunião"),
      "Rascunho do intervalo X",
    );
    fireEvent.change(screen.getByLabelText("Início da reserva"), {
      target: { value: localValue(Date.parse("2030-01-01T12:00:00Z")) },
    });
    fireEvent.change(screen.getByLabelText("Término da reserva"), {
      target: { value: localValue(Date.parse("2030-01-01T13:00:00Z")) },
    });
    fireEvent.change(screen.getByLabelText("Participantes"), {
      target: { value: "6" },
    });
    await userEvent.click(
      screen.getByRole("link", { name: /Salas e horários/ }),
    );
    const start = localValue(Date.parse("2030-01-01T15:00:00Z")),
      end = localValue(Date.parse("2030-01-01T16:00:00Z"));
    fireEvent.change(await screen.findByLabelText("Início da busca"), {
      target: { value: start },
    });
    fireEvent.change(screen.getByLabelText("Término da busca"), {
      target: { value: end },
    });
    fireEvent.change(screen.getByLabelText("Pessoas na busca"), {
      target: { value: "7" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Buscar salas" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Reservar Sala Cedro" }),
    );
    expect(await screen.findByLabelText("Título da reunião")).toHaveValue("");
    expect(screen.getByLabelText("Início da reserva")).toHaveValue(start);
    expect(screen.getByLabelText("Término da reserva")).toHaveValue(end);
    expect(screen.getByLabelText("Participantes")).toHaveValue(7);
    await userEvent.type(
      screen.getByLabelText("Título da reunião"),
      "Encontro Y",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Confirmar reserva" }),
    );
    await screen.findByRole("note", { name: "Confirmação" });
    const post = backend.fetch.mock.calls.find(
      ([path, options]) =>
        path === "/api/reservations" && options?.method === "POST",
    )!;
    const body = JSON.parse(String(post[1]?.body));
    expect(Date.parse(body.starts_at)).toBe(Date.parse("2030-01-01T15:00:00Z"));
    expect(body.participants).toBe(7);
  });
  it("restores suggested defaults on the same direct URL after expiry and a later server clock", async () => {
    const backend = server();
    render(
      <MemoryRouter initialEntries={["/reservations/new?room_id=1"]}>
        <App />
      </MemoryRouter>,
    );
    await userEvent.type(
      await screen.findByLabelText("Título da reunião"),
      "Mesma intenção sem parâmetros",
    );
    const start = (
      screen.getByLabelText("Início da reserva") as HTMLInputElement
    ).value;
    const end = (
      screen.getByLabelText("Término da reserva") as HTMLInputElement
    ).value;
    backend.expire();
    await userEvent.click(
      screen.getByRole("button", { name: "Confirmar reserva" }),
    );
    await screen.findByLabelText("E-mail");
    backend.setClock("2030-01-01T14:00:00Z");
    await login();
    expect(await screen.findByLabelText("Título da reunião")).toHaveValue(
      "Mesma intenção sem parâmetros",
    );
    expect(screen.getByLabelText("Início da reserva")).toHaveValue(start);
    expect(screen.getByLabelText("Término da reserva")).toHaveValue(end);
    expect(
      screen.getByRole("button", { name: "Confirmar reserva" }),
    ).toBeDisabled();
  });
  it("detects an account changed in another tab before permitting a booking", async () => {
    const backend = server();
    render(
      <MemoryRouter initialEntries={[bookingPath()]}>
        <App />
      </MemoryRouter>,
    );
    await userEvent.type(
      await screen.findByLabelText("Título da reunião"),
      "Texto particular A",
    );
    backend.switchAccount(admin);
    backend.loginAs(admin);
    fireEvent(window, new Event("focus"));
    await screen.findByRole("heading", { name: "Bom ter você aqui." });
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Atualizações da página" }),
      ).toHaveTextContent(/A conta foi alterada em outra aba/),
    );
    const warning = screen.getByRole("note");
    expect(warning).toHaveTextContent(/A conta foi alterada em outra aba/);
    expect(warning).toBeVisible();
    await login(admin);
    expect(await screen.findByLabelText("Título da reunião")).toHaveValue("");
    expect(
      backend.fetch.mock.calls.filter(
        ([path, options]) =>
          path === "/api/reservations" && options?.method === "POST",
      ),
    ).toHaveLength(0);
  });
  it("holds a mutation during identity checking and refuses it after owner mismatch", async () => {
    const backend = server();
    render(
      <MemoryRouter initialEntries={[bookingPath()]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByLabelText("Título da reunião");
    backend.switchAccount(admin);
    const release = backend.pauseIdentity();
    fireEvent(window, new Event("focus"));
    const outcome = api
      .request("/reservations", { method: "POST", body: { title: "Texto A" } })
      .then(
        () => "sent",
        () => "blocked",
      );
    await waitFor(() =>
      expect(
        backend.fetch.mock.calls.filter(
          ([path]) => path === "/api/session/csrf",
        ).length,
      ).toBeGreaterThan(1),
    );
    expect(
      backend.fetch.mock.calls.filter(
        ([path, options]) =>
          path === "/api/reservations" && options?.method === "POST",
      ),
    ).toHaveLength(0);
    release();
    expect(await outcome).toBe("blocked");
    await screen.findByRole("heading", { name: "Bom ter você aqui." });
  });
  it("discards an old identity response after expiry and an explicit login to another owner", async () => {
    const backend = server();
    render(
      <MemoryRouter initialEntries={[bookingPath()]}>
        <App />
      </MemoryRouter>,
    );
    await userEvent.type(
      await screen.findByLabelText("Título da reunião"),
      "Privado A",
    );
    const release = backend.pauseIdentity();
    fireEvent(window, new Event("focus"));
    const pending = api
      .request("/reservations", {
        method: "POST",
        body: { title: "Privado A" },
      })
      .then(
        () => "sent",
        () => "blocked",
      );
    await waitFor(() =>
      expect(
        backend.fetch.mock.calls.filter(([path]) => path === "/api/session/me"),
      ).toHaveLength(2),
    );
    fireEvent(window, new Event("salafacil:session-expired"));
    backend.loginAs(admin);
    await login(admin);
    expect(await screen.findByLabelText("Título da reunião")).toHaveValue("");
    release();
    expect(await pending).toBe("blocked");
    expect(screen.getByText("Administrador")).toBeInTheDocument();
    expect(screen.queryByLabelText("E-mail")).not.toBeInTheDocument();
    expect(
      backend.fetch.mock.calls.filter(
        ([path, options]) =>
          path === "/api/reservations" && options?.method === "POST",
      ),
    ).toHaveLength(0);
  });
  it("blocks writes while identity is unavailable and lets the same owner recover without losing fields", async () => {
    const backend = server();
    render(
      <MemoryRouter initialEntries={[bookingPath()]}>
        <App />
      </MemoryRouter>,
    );
    await userEvent.type(
      await screen.findByLabelText("Título da reunião"),
      "Rascunho seguro",
    );
    backend.failIdentity(true);
    await userEvent.click(
      screen.getByRole("button", { name: "Confirmar reserva" }),
    );
    await screen.findByRole("button", { name: "Verificar sessão novamente" });
    expect(
      screen.getByLabelText("Título da reunião").closest("[inert]"),
    ).not.toBeNull();
    expect(
      backend.fetch.mock.calls.filter(
        ([path, options]) =>
          path === "/api/reservations" && options?.method === "POST",
      ),
    ).toHaveLength(0);
    backend.failIdentity(false);
    await userEvent.click(
      screen.getByRole("button", { name: "Verificar sessão novamente" }),
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText("Título da reunião").closest("[inert]"),
      ).toBeNull(),
    );
    expect(screen.getByLabelText("Título da reunião")).toHaveValue(
      "Rascunho seguro",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Confirmar reserva" }),
    );
    await screen.findByRole("note", { name: "Confirmação" });
  });
});
describe("O4-C3 session recovery focus", () => {
  it("returns to the original inline field after the temporary retry is removed", async () => {
    const backend = server();
    render(
      <MemoryRouter initialEntries={[bookingPath()]}>
        <App />
      </MemoryRouter>,
    );
    await userEvent.type(
      await screen.findByLabelText("Título da reunião"),
      "Contexto preservado",
    );
    const origin = screen.getByLabelText("Participantes");
    await userEvent.click(origin);
    backend.failIdentity(true);
    fireEvent(window, new Event("focus"));
    const retry = await screen.findByRole("button", {
      name: "Verificar sessão novamente",
    });
    await userEvent.tab();
    expect(retry).toHaveFocus();
    backend.failIdentity(false);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(origin).toHaveFocus());
    expect(retry).not.toBeInTheDocument();
    expect(screen.getByLabelText("Título da reunião")).toHaveValue(
      "Contexto preservado",
    );
    await userEvent.tab();
    expect(screen.getByLabelText("Descrição (opcional)")).toHaveFocus();
  });
  it("uses the page heading when the original modal field was unmounted", async () => {
    const backend = server(admin);
    render(
      <MemoryRouter initialEntries={["/admin/rooms"]}>
        <App />
      </MemoryRouter>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "+ Nova sala" }),
    );
    const origin = screen.getByLabelText("Nome da sala");
    await userEvent.type(origin, "Origem no modal");
    backend.failIdentity(true);
    fireEvent(window, new Event("focus"));
    await screen.findByRole("button", { name: "Verificar sessão novamente" });
    await userEvent.click(screen.getByRole("button", { name: "Voltar" }));
    expect(origin).not.toBeInTheDocument();
    backend.failIdentity(false);
    await userEvent.click(
      screen.getByRole("button", { name: "Verificar sessão novamente" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveFocus(),
    );
  });
  it("keeps repeated failures reachable by keyboard without replacing the original field", async () => {
    const backend = server();
    render(
      <MemoryRouter initialEntries={[bookingPath()]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByLabelText("Título da reunião");
    const origin = screen.getByLabelText("Participantes");
    await userEvent.click(origin);
    backend.failIdentity(true);
    fireEvent(window, new Event("focus"));
    const firstRetry = await screen.findByRole("button", {
      name: "Verificar sessão novamente",
    });
    await userEvent.tab();
    expect(firstRetry).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(firstRetry).not.toBeInTheDocument());
    const nextRetry = await screen.findByRole("button", {
      name: "Verificar sessão novamente",
    });
    expect(screen.getByRole("alert")).toHaveFocus();
    await userEvent.tab();
    expect(nextRetry).toHaveFocus();
    backend.failIdentity(false);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(origin).toHaveFocus());
  });
  it("does not steal valid focus inside an open modal after a successful recheck", async () => {
    const backend = server(admin);
    render(
      <MemoryRouter initialEntries={["/admin/rooms"]}>
        <App />
      </MemoryRouter>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "+ Nova sala" }),
    );
    await userEvent.type(screen.getByLabelText("Nome da sala"), "Rascunho");
    backend.failIdentity(true);
    fireEvent(window, new Event("focus"));
    await screen.findByRole("button", { name: "Verificar sessão novamente" });
    backend.failIdentity(false);
    const release = backend.pauseIdentity();
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(screen.getByRole("dialog").closest("[inert]")).not.toBeNull(),
    );
    const current = screen.getByLabelText("Capacidade");
    await userEvent.click(current);
    release();
    await waitFor(() =>
      expect(screen.getByRole("dialog").closest("[inert]")).toBeNull(),
    );
    expect(current).toHaveFocus();
    expect(screen.getByLabelText("Nome da sala")).toHaveValue("Rascunho");
  });
});
describe("O4-C4 passive session checking", () => {
  it.each(["focus", "visibilitychange"])(
    "does not move focus from body after a successful passive %s check",
    async (eventName) => {
      const backend = server();
      render(
        <MemoryRouter initialEntries={[bookingPath()]}>
          <App />
        </MemoryRouter>,
      );
      const field = await screen.findByLabelText("Título da reunião");
      await userEvent.click(field);
      field.blur();
      expect(document.body).toHaveFocus();
      const headingFocus = vi.spyOn(
        screen.getByRole("heading", { level: 1 }),
        "focus",
      );
      const release = backend.pauseIdentity();
      fireEvent(
        eventName === "focus" ? window : document,
        new Event(eventName),
      );
      await waitFor(() => expect(field.closest("[inert]")).not.toBeNull());
      await act(async () => release());
      await waitFor(() => expect(field.closest("[inert]")).toBeNull());
      expect(document.body).toHaveFocus();
      expect(headingFocus).not.toHaveBeenCalled();
    },
  );
  it("does not treat the document element as a return target", async () => {
    const backend = server();
    render(
      <MemoryRouter initialEntries={[bookingPath()]}>
        <App />
      </MemoryRouter>,
    );
    const field = await screen.findByLabelText("Título da reunião");
    document.documentElement.tabIndex = -1;
    document.documentElement.focus();
    const release = backend.pauseIdentity();
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(field.closest("[inert]")).not.toBeNull());
    document.documentElement.blur();
    document.documentElement.removeAttribute("tabindex");
    await act(async () => release());
    await waitFor(() => expect(field.closest("[inert]")).toBeNull());
    expect(document.body).toHaveFocus();
  });
  it("does not fall back to the heading while a connected submit button is disabled", async () => {
    const backend = server();
    render(
      <MemoryRouter initialEntries={[bookingPath()]}>
        <App />
      </MemoryRouter>,
    );
    await userEvent.type(
      await screen.findByLabelText("Título da reunião"),
      "Reserva em andamento",
    );
    const headingFocus = vi.spyOn(
      screen.getByRole("heading", { level: 1 }),
      "focus",
    );
    const releaseIdentity = backend.pauseIdentity();
    const releaseReservation = backend.pauseReservation();
    const submit = screen.getByRole("button", { name: "Confirmar reserva" });
    await userEvent.click(submit);
    expect(submit).toBeDisabled();
    // Model native focus fixup: jsdom neither blurs disabled controls nor
    // moves focus to body when a focused fieldset becomes disabled/inert.
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
    expect(document.body).toHaveFocus();
    await act(async () => releaseIdentity());
    await waitFor(() =>
      expect(
        backend.fetch.mock.calls.filter(
          ([path, options]) =>
            path === "/api/reservations" && options?.method === "POST",
        ),
      ).toHaveLength(1),
    );
    await waitFor(() => expect(submit.closest("[inert]")).toBeNull());
    const focusWhilePending = document.activeElement;
    expect(submit).toBeDisabled();
    expect(submit).toBeInTheDocument();
    releaseReservation();
    const confirmation = await screen.findByRole("note", {
      name: "Confirmação",
    });
    expect(confirmation).toHaveFocus();
    expect(focusWhilePending).toBe(document.body);
    expect(headingFocus).not.toHaveBeenCalled();
  });
});
describe("memory drafts tied to session owner", () => {
  it.each([false, true])(
    "restores booking only for the same owner (switch=%s)",
    async (switchAccount) => {
      const backend = server();
      render(
        <MemoryRouter initialEntries={[bookingPath()]}>
          <App />
        </MemoryRouter>,
      );
      const actor = userEvent.setup();
      await actor.type(
        await screen.findByLabelText("Título da reunião"),
        "Rascunho particular",
      );
      await actor.type(
        screen.getByLabelText("Descrição (opcional)"),
        "Pauta mantida",
      );
      backend.expire();
      if (switchAccount) backend.loginAs(admin);
      await actor.click(
        screen.getByRole("button", { name: "Confirmar reserva" }),
      );
      await login(switchAccount ? admin : member);
      expect(await screen.findByLabelText("Título da reunião")).toHaveValue(
        switchAccount ? "" : "Rascunho particular",
      );
      expect(screen.getByLabelText("Descrição (opcional)")).toHaveValue(
        switchAccount ? "" : "Pauta mantida",
      );
      if (!switchAccount) {
        await actor.click(
          screen.getByRole("button", { name: "Sair da conta" }),
        );
        await login();
        expect(await screen.findByLabelText("Título da reunião")).toHaveValue(
          "",
        );
      }
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
      expect(
        backend.fetch.mock.calls.filter(
          ([path, options]) =>
            path === "/api/reservations" && options?.method === "POST",
        ),
      ).toHaveLength(1);
    },
  );
  it.each([false, true])(
    "restores the administrative editor and edited fields after expiry (existing=%s)",
    async (existing) => {
      const backend = server(admin);
      render(
        <MemoryRouter initialEntries={["/admin/rooms"]}>
          <App />
        </MemoryRouter>,
      );
      const actor = userEvent.setup();
      await actor.click(
        await screen.findByRole("button", {
          name: existing ? "Editar Sala Cedro" : "+ Nova sala",
        }),
      );
      await actor.clear(screen.getByLabelText("Nome da sala"));
      await actor.clear(screen.getByLabelText("Localização"));
      await actor.clear(screen.getByLabelText("Descrição da sala"));
      await actor.type(screen.getByLabelText("Nome da sala"), "Novo espaço");
      await actor.type(screen.getByLabelText("Localização"), "Andar 5");
      await actor.type(
        screen.getByLabelText("Descrição da sala"),
        "Pauta administrativa",
      );
      backend.expire();
      await actor.click(
        screen.getByRole("button", {
          name: existing ? "Salvar alterações" : "Criar sala",
        }),
      );
      await login(admin);
      expect(
        await screen.findByRole("dialog", {
          name: existing ? "Editar sala" : "Nova sala",
        }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Nome da sala")).toHaveValue("Novo espaço");
      expect(screen.getByLabelText("Localização")).toHaveValue("Andar 5");
      expect(screen.getByLabelText("Descrição da sala")).toHaveValue(
        "Pauta administrativa",
      );
    },
  );
  it("reconciles a clock update between rendering and subscribing", () => {
    function ReadClock() {
      useTick(10000);
      return (
        <output aria-label="Relógio lido">
          {new Date(estimatedNow()!).toISOString().slice(0, 19)}
        </output>
      );
    }
    function ResyncDuringLayout() {
      useLayoutEffect(() => {
        syncClock("2030-01-01T13:00:00Z", performance.now(), performance.now());
      }, []);
      return <ReadClock />;
    }
    render(<ResyncDuringLayout />);
    expect(screen.getByLabelText("Relógio lido")).toHaveTextContent(
      "2030-01-01T13:00:00",
    );
  });
  it.each(["focus", "visibilitychange"])(
    "resynchronizes with the server on %s despite a divergent civil clock",
    async (eventName) => {
      const backend = server();
      render(
        <MemoryRouter initialEntries={[bookingPath()]}>
          <App />
        </MemoryRouter>,
      );
      await screen.findByLabelText("Título da reunião");
      expect(
        screen.getByRole("button", { name: "Confirmar reserva" }),
      ).toBeEnabled();
      const before = backend.fetch.mock.calls.filter(
        ([path]) => path === "/api/session/csrf",
      ).length;
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("1990-01-01T00:00:00Z"));
      backend.setClock("2030-01-01T13:00:00Z");
      fireEvent(
        eventName === "focus" ? window : document,
        new Event(eventName),
      );
      // The clock is updated before its event-driven React commit; require both.
      await waitFor(() => {
        expect(estimatedNow()).toBeGreaterThanOrEqual(
          Date.parse("2030-01-01T13:00:00Z"),
        );
        expect(
          screen.getByRole("button", { name: "Confirmar reserva" }),
        ).toBeDisabled();
        expect(
          screen.getByText(/Confira o início da reserva/),
        ).toBeInTheDocument();
      });
      expect(
        backend.fetch.mock.calls.filter(
          ([path]) => path === "/api/session/csrf",
        ),
      ).toHaveLength(before + 1);
    },
  );
});
describe("recovery, focus, and persistent announcements", () => {
  it("keeps one live region mounted before loading and success text changes", async () => {
    function Harness() {
      const [state, setState] = useState(0);
      return (
        <LiveProvider>
          <button onClick={() => setState((value) => value + 1)}>
            Avançar
          </button>
          {state === 1 ? (
            <Loading label="Consultando" />
          ) : state === 2 ? (
            <Notice>Concluído</Notice>
          ) : null}
        </LiveProvider>
      );
    }
    render(<Harness />);
    const live = screen.getByRole("status");
    expect(live).toHaveTextContent("");
    await userEvent.click(screen.getByRole("button"));
    expect(live).toHaveTextContent("Consultando");
    await userEvent.click(screen.getByRole("button"));
    expect(live).toHaveTextContent("Concluído");
    expect(screen.getByRole("note", { name: "Confirmação" })).toHaveFocus();
    expect(screen.getByRole("status")).toBe(live);
  });
  it("shows Retry-After and a contextual conflict title", () => {
    render(
      <MemoryRouter>
        <ErrorPanel
          error={
            new api.ApiError(
              429,
              "LOGIN_RATE_LIMITED",
              "Limite atingido",
              {},
              false,
              "360",
            )
          }
        />
        <ErrorPanel
          error={new api.ApiError(409, "INVALID_ROOM_STATE", "Sala inativa")}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/360 segundos \(6 min\)/)).toBeInTheDocument();
    expect(screen.getByText("O estado da sala mudou.")).toBeInTheDocument();
    expect(screen.queryByText(/conflito de horário/i)).not.toBeInTheDocument();
  });
  it("queries the correct administrative reservation after an uncertain cancellation", async () => {
    vi.spyOn(api, "request").mockRejectedValue(
      new api.ApiError(503, "SERVICE_UNAVAILABLE", "Não confirmado", {}, true),
    );
    render(
      <MemoryRouter>
        <CancelDialog
          reservation={reservation}
          reviewHref={`/admin/reservations/${reservation.id}`}
          onClose={vi.fn()}
          onCancelled={vi.fn()}
        />
      </MemoryRouter>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Cancelar reserva" }),
    );
    expect(
      await screen.findByRole("link", { name: "Consultar estado da reserva" }),
    ).toHaveAttribute("href", `/admin/reservations/${reservation.id}`);
    expect(
      screen.getByRole("button", { name: "Cancelar reserva" }),
    ).toBeDisabled();
  });
  it("keeps filter correction focus while typing after invalid dates", async () => {
    vi.spyOn(api, "request").mockResolvedValue(page());
    render(
      <MemoryRouter>
        <Reservations />
      </MemoryRouter>,
    );
    await screen.findByText("Nenhuma próxima reserva");
    fireEvent.change(screen.getByLabelText("Período: a partir de"), {
      target: { value: "2030-01-02T10:00" },
    });
    fireEvent.change(screen.getByLabelText("Período: até"), {
      target: { value: "2030-01-01T10:00" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Aplicar filtros" }),
    );
    expect(screen.getByRole("alert")).toHaveFocus();
    await userEvent.click(screen.getByLabelText("ID da sala"));
    await userEvent.keyboard("123");
    expect(screen.getByLabelText("ID da sala")).toHaveValue(123);
    expect(screen.getByLabelText("ID da sala")).toHaveFocus();
  });
  it("focuses stable success feedback after room edit and real list reload", async () => {
    const request = vi
      .spyOn(api, "request")
      .mockImplementation(async (_path, options) =>
        options?.method ? room : page([room]),
      );
    render(
      <MemoryRouter>
        <LiveProvider>
          <AdminRooms />
        </LiveProvider>
      </MemoryRouter>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Editar Sala Cedro" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Salvar alterações" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("note", { name: "Confirmação" })).toHaveFocus(),
    );
    await screen.findByRole("button", { name: "Editar Sala Cedro" });
    expect(screen.getByRole("note", { name: "Confirmação" })).toHaveFocus();
    expect(
      request.mock.calls.filter(([, options]) => !options?.method),
    ).toHaveLength(2);
  });
  it("reconciles invalid admin transitions on Escape", async () => {
    let reads = 0;
    vi.spyOn(api, "request").mockImplementation(async (path, options) => {
      if (options?.method)
        throw new api.ApiError(409, "INVALID_ROOM_STATE", "Sala inativa");
      if (path.startsWith("/rooms"))
        return page([{ ...room, status: reads++ ? "inactive" : "active" }]);
      return page();
    });
    render(
      <MemoryRouter>
        <AdminRooms />
      </MemoryRouter>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /^Bloquear/ }),
    );
    await screen.findByText(/0 reservas confirmadas/);
    await userEvent.type(
      screen.getByLabelText("Motivo do bloqueio"),
      "Manutenção",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Bloquear sala" }),
    );
    await screen.findByText("O estado da sala mudou.");
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { bubbles: true, cancelable: true }),
    );
    expect(
      await screen.findByRole("button", { name: /^Reativar/ }),
    ).toBeInTheDocument();
    expect(reads).toBe(2);
  });
  it.each(["cancelled", "past", "all"] as const)(
    "uses contextual empty copy for %s",
    (emptyKind) => {
      render(
        <MemoryRouter>
          <BookingRows
            items={[]}
            emptyKind={emptyKind}
            admin
            onCancel={vi.fn()}
          />
        </MemoryRouter>,
      );
      expect(
        screen.queryByText(/Encontre um horário para/),
      ).not.toBeInTheDocument();
    },
  );
});
function HistoryControls() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate(-1)}>Navegar atrás</button>
      <button onClick={() => navigate(1)}>Navegar adiante</button>
    </>
  );
}
describe("filtered reservations after cancellation", () => {
  it.each([
    { view: "upcoming", admin: false },
    { view: "upcoming", admin: true },
    { view: "all", admin: true },
  ])(
    "requeries $view (admin=$admin) and keeps stable success focus",
    async ({ view, admin: isAdmin }) => {
      let cancelled = false;
      const request = vi
        .spyOn(api, "request")
        .mockImplementation(async (path, options) => {
          if (options?.method === "POST") {
            cancelled = true;
            return {
              ...reservation,
              status: "cancelled",
              cancelled_at: "2030-01-01T10:02:00Z",
            };
          }
          const params = new URLSearchParams(path.split("?")[1]);
          const status = cancelled ? "cancelled" : "confirmed";
          const rows =
            params.get("status") && params.get("status") !== status
              ? []
              : [
                  {
                    ...reservation,
                    status,
                    cancelled_at: cancelled ? "2030-01-01T10:02:00Z" : null,
                    ...(isAdmin ? { user: member } : {}),
                  },
                ];
          return page(rows);
        });
      render(
        <MemoryRouter initialEntries={[`/reservations?view=${view}`]}>
          <LiveProvider>
            <Reservations admin={isAdmin} />
          </LiveProvider>
        </MemoryRouter>,
      );
      await userEvent.click(
        await screen.findByRole("button", { name: /^Cancelar/ }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Cancelar reserva" }),
      );
      await waitFor(() =>
        expect(
          request.mock.calls.filter(([, options]) => !options?.method),
        ).toHaveLength(2),
      );
      const notice = screen.getByRole("note", { name: "Confirmação" });
      if (view === "upcoming") {
        await screen.findByText("Nenhuma próxima reserva");
        expect(screen.getByText(/0 registros · página 1/)).toBeInTheDocument();
        expect(
          screen.queryByRole("heading", { name: "Planejamento" }),
        ).not.toBeInTheDocument();
      } else {
        const row = (
          await screen.findByRole("heading", { name: "Planejamento" })
        ).closest("article")!;
        expect(within(row).getByText("Cancelada")).toBeInTheDocument();
        expect(screen.getByText(/1 registros · página 1/)).toBeInTheDocument();
        expect(
          screen.getByText(`${member.name} · ${member.email}`),
        ).toBeInTheDocument();
      }
      expect(notice).toHaveFocus();
      await userEvent.click(screen.getByRole("button", { name: "Canceladas" }));
      await screen.findByText("Cancelada");
      expect(screen.getByText(/1 registros · página 1/)).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Planejamento" }),
      ).toBeInTheDocument();
      expect(
        request.mock.calls.filter(([, options]) => options?.method === "POST"),
      ).toHaveLength(1);
    },
  );
  it("retains the administrative detail owner when cancel response omits user", async () => {
    vi.spyOn(api, "request").mockImplementation(async (_path, options) =>
      options?.method
        ? {
            ...reservation,
            status: "cancelled",
            cancelled_at: "2030-01-01T10:02:00Z",
          }
        : { ...reservation, user: member },
    );
    render(
      <MemoryRouter initialEntries={[`/admin/reservations/${reservation.id}`]}>
        <LiveProvider>
          <Routes>
            <Route
              path="/admin/reservations/:id"
              element={<ReservationDetail admin />}
            />
          </Routes>
        </LiveProvider>
      </MemoryRouter>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Cancelar reserva" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancelar reserva",
      }),
    );
    await screen.findByText("Cancelada");
    expect(
      screen.getByText(`${member.name} · ${member.email}`),
    ).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Confirmação" })).toHaveFocus();
  });
});
describe("URL and data reconciliation", () => {
  it("recovers an out of range page with an explicit first-page action", async () => {
    vi.spyOn(api, "request").mockImplementation(async (path) => {
      if (path.includes("page=999"))
        throw new api.ApiError(400, "VALIDATION_ERROR", "Página inválida", {
          page: ["Página inexistente."],
        });
      return page();
    });
    render(
      <MemoryRouter initialEntries={["/reservations?page=999"]}>
        <Reservations />
      </MemoryRouter>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Voltar à primeira página" }),
    );
    expect(
      await screen.findByText("Nenhuma próxima reserva"),
    ).toBeInTheDocument();
  });
  it("restores audit cursor history from URL and synchronizes filters on back", async () => {
    const request = vi
      .spyOn(api, "request")
      .mockResolvedValue({ results: [], next_cursor: null, has_more: false });
    const trail = encodeURIComponent(JSON.stringify([""]));
    render(
      <MemoryRouter
        initialEntries={[
          `/admin/audit?type=room.created&actor_id=2&cursor=10&trail=${trail}`,
        ]}
      >
        <HistoryControls />
        <Audit />
      </MemoryRouter>,
    );
    await screen.findByText("Nenhum evento neste período");
    await userEvent.click(screen.getByRole("button", { name: "Anteriores" }));
    await waitFor(() =>
      expect(request.mock.lastCall?.[0]).not.toContain("cursor=10"),
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Tipo de evento"),
      "reservation.created",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Filtrar eventos" }),
    );
    expect(screen.getByLabelText("Tipo de evento")).toHaveValue(
      "reservation.created",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Navegar atrás" }),
    );
    expect(screen.getByLabelText("Tipo de evento")).toHaveValue("room.created");
    await userEvent.click(
      screen.getByRole("button", { name: "Navegar atrás" }),
    );
    await waitFor(() =>
      expect(request.mock.lastCall?.[0]).toContain("cursor=10"),
    );
  });
  it("removes stale records when a subsequent GET fails and reloads identical filters", async () => {
    let reads = 0;
    vi.spyOn(api, "request").mockImplementation(async () => {
      if (reads++)
        throw new api.ApiError(503, "SERVICE_UNAVAILABLE", "Sem conexão");
      return page([room]);
    });
    render(
      <MemoryRouter>
        <AdminRooms />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "Sala Cedro" });
    await userEvent.click(
      screen.getByRole("button", { name: "Filtrar salas" }),
    );
    await screen.findByText("Sem conexão");
    expect(
      screen.queryByRole("heading", { name: "Sala Cedro" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Filtrar salas" }),
    );
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
  });
});
