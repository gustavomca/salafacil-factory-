import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  ApiError,
  clearCsrf,
  refreshCsrf,
  registerMutationGuard,
  request,
} from "./api";
beforeEach(() => clearCsrf());
afterEach(() => vi.restoreAllMocks());
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
describe("same origin API", () => {
  it("obtains masked CSRF before mutation and sends it only in the request header", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({
          csrf_token: "masked-token",
          server_now: "2030-01-01T10:00:00Z",
        }),
      )
      .mockResolvedValueOnce(response({ user: { id: 1 } }));
    await request("/session/login", {
      method: "POST",
      body: { email: "m@example.test", password: "test-only" },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe("/api/session/csrf");
    expect(fetch.mock.calls[1][1]).toMatchObject({
      credentials: "same-origin",
      method: "POST",
      headers: { "X-CSRFToken": "masked-token" },
    });
    expect(localStorage.length).toBe(0);
  });
  it("preserves field errors from 400", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Inválido",
            details: { title: ["Informe um título."] },
          },
        },
        400,
      ),
    );
    await expect(request("/rooms")).rejects.toMatchObject({
      status: 400,
      details: { title: ["Informe um título."] },
    });
  });
  it("signals expired session for protected 401, but not invalid login credentials", async () => {
    const expired = vi.fn();
    window.addEventListener("salafacil:session-expired", expired);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response(
          { error: { code: "INVALID_CREDENTIALS", message: "Inválido" } },
          401,
        ),
      )
      .mockResolvedValueOnce(
        response({ error: { code: "AUTH_REQUIRED", message: "Entre" } }, 401),
      );
    await expect(request("/test-login")).rejects.toBeInstanceOf(ApiError);
    expect(expired).not.toHaveBeenCalled();
    await expect(request("/rooms")).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    window.removeEventListener("salafacil:session-expired", expired);
  });
  it("never retries an uncertain mutation", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({ csrf_token: "masked", server_now: "2030-01-01T10:00:00Z" }),
      )
      .mockRejectedValueOnce(new TypeError("network lost"));
    await expect(
      request("/reservations", { method: "POST", body: { title: "test" } }),
    ).rejects.toMatchObject({ uncertain: true, status: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("keeps permission refusal distinct from expired session", async () => {
    const expired = vi.fn();
    window.addEventListener("salafacil:session-expired", expired);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response(
        { error: { code: "FORBIDDEN", message: "Sem permissão", details: {} } },
        403,
      ),
    );
    await expect(request("/reservations/other")).rejects.toMatchObject({
      status: 403,
      uncertain: false,
    });
    expect(expired).not.toHaveBeenCalled();
    window.removeEventListener("salafacil:session-expired", expired);
  });
  it("does not treat an HTML response to mutation as a confirmed failure", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ csrf_token: "masked" }))
      .mockResolvedValueOnce(
        new Response("<html>Proxy error</html>", { status: 502 }),
      );
    await expect(
      request("/rooms", { method: "POST", body: {} }),
    ).rejects.toMatchObject({ uncertain: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("review regressions: uncertain results and retry timing", () => {
  it.each([
    [503, "SERVICE_UNAVAILABLE", true],
    [500, "INTERNAL_ERROR", true],
    [502, "HTTP_ERROR", true],
    [503, "RETRY_LATER", false],
  ])(
    "classifies %s %s without retrying the mutation",
    async (status, code, uncertain) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(response({ csrf_token: "masked" }))
        .mockResolvedValueOnce(
          response(
            { error: { code, message: "Falha do servidor", details: {} } },
            Number(status),
          ),
        );
      await expect(
        request("/rooms", { method: "POST", body: { name: "Sala" } }),
      ).rejects.toMatchObject({ uncertain });
      expect(
        fetch.mock.calls.filter(([, options]) => options?.method === "POST"),
      ).toHaveLength(1);
    },
  );
  it("preserves Retry-After for the visible login limit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "LOGIN_RATE_LIMITED",
            message: "Limite atingido",
            details: {},
          },
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "360" },
        },
      ),
    );
    await expect(request("/limit")).rejects.toMatchObject({
      retryAfter: "360",
      uncertain: false,
    });
  });
});

describe("identity-bound mutation token", () => {
  it("uses the token snapshot validated with the displayed identity despite another refresh", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (path) =>
        String(path) === "/api/session/csrf"
          ? response({ csrf_token: "token-new-other-session" })
          : response({ id: 1 }),
      );
    const unregister = registerMutationGuard(async () => {
      await refreshCsrf();
      return "token-validated-with-owner";
    });
    try {
      await request("/reservations", {
        method: "POST",
        body: { title: "Test" },
      });
      expect(
        fetch.mock.calls.find(([path]) => path === "/api/reservations")?.[1]
          ?.headers,
      ).toMatchObject({ "X-CSRFToken": "token-validated-with-owner" });
    } finally {
      unregister();
    }
  });
});
