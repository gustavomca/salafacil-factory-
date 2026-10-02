import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import App from "./App";
import { clearCsrf } from "./api";
const user = {
  id: 1,
  name: "Membro de teste",
  email: "membro@example.test",
  role: "member",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  clearCsrf();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
function mockServer(authenticated = false) {
  let active = authenticated;
  let token = "token-before";
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, options) => {
      const path = String(input);
      if (path === "/api/session/csrf")
        return json({
          csrf_token: token,
          server_now: new Date().toISOString(),
        });
      if (path === "/api/session/me")
        return json({ user: active ? user : null });
      if (path === "/api/session/login") {
        active = true;
        token = "token-after";
        return json({ user });
      }
      if (path === "/api/session/logout") {
        active = false;
        return new Response(null, { status: 204 });
      }
      if (path.startsWith("/api/dashboard"))
        return json({
          server_now: new Date().toISOString(),
          date: "2030-01-01",
          tz: "UTC",
          today: [],
          upcoming: [],
          counts: { my_today: 0, my_upcoming: 0, available_now: 0 },
        });
      if (path.startsWith("/api/rooms"))
        return json({ count: 0, next: null, previous: null, results: [] });
      throw new Error(`Unexpected request ${options?.method ?? "GET"} ${path}`);
    });
}
describe("session and role navigation", () => {
  it("restores member session and never fetches the admin resource on direct navigation", async () => {
    const fetch = mockServer(true);
    render(
      <MemoryRouter initialEntries={["/admin/audit"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "Este espaço é restrito." }),
    ).toBeInTheDocument();
    expect(
      fetch.mock.calls.some((call) => String(call[0]).includes("audit-events")),
    ).toBe(false);
    expect(
      screen.queryByRole("link", { name: "Auditoria" }),
    ).not.toBeInTheDocument();
  });
  it("rotates the CSRF token after login and uses the new token to logout", async () => {
    const fetch = mockServer();
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByLabelText("E-mail");
    const actor = userEvent.setup();
    await actor.type(screen.getByLabelText("E-mail"), "membro@example.test");
    await actor.type(screen.getByLabelText("Senha"), "password-for-test");
    await actor.click(screen.getByRole("button", { name: "Entrar" }));
    await screen.findByRole("heading", { name: "Sua agenda, em dia." });
    const login = fetch.mock.calls.find(
      (call) => call[0] === "/api/session/login",
    );
    expect(login?.[1]?.headers).toMatchObject({
      "X-CSRFToken": "token-before",
    });
    await actor.click(screen.getByRole("button", { name: "Sair da conta" }));
    await screen.findByRole("heading", { name: "Bom ter você aqui." });
    const logout = fetch.mock.calls.find(
      (call) => call[0] === "/api/session/logout",
    );
    expect(logout?.[1]?.headers).toMatchObject({
      "X-CSRFToken": "token-after",
    });
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });
  it("redirects an expired protected request to login with an explicit message", async () => {
    const fetch = mockServer(true);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, options) =>
      String(input).startsWith("/api/dashboard")
        ? json(
            {
              error: {
                code: "AUTH_REQUIRED",
                message: "Sessão expirada.",
                details: {},
              },
            },
            401,
          )
        : original(input, options),
    );
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "Bom ter você aqui." }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Sua sessão expirou",
      ),
    );
    expect(screen.queryByText("Membro de teste")).not.toBeInTheDocument();
  });
  it("shows an authenticated 404 instead of a blank page", async () => {
    mockServer(true);
    render(
      <MemoryRouter initialEntries={["/rota-inexistente"]}>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Não encontramos esta página." }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("link", { name: "Voltar ao meu dia" }),
    ).toHaveAttribute("href", "/dashboard");
  });
});
