import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import axe from "axe-core";
import * as api from "./api";
import { ReservationForm } from "./rooms";
import { BookingRows, CancelDialog } from "./reservations";
import { DateTimeField, resolveLocal } from "./ui";
import { AdminRooms, RoomEditor, RoomTransition } from "./admin";
import { localValue, syncClock } from "./time";
import type { Reservation, Room } from "./types";
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
const props = () => ({
  room,
  initialStart: {
    value: localValue(Date.parse(reservation.starts_at)),
    choice: "",
  },
  initialEnd: {
    value: localValue(Date.parse(reservation.ends_at)),
    choice: "",
  },
  initialPeople: "4",
  onClose: vi.fn(),
  onRefresh: vi.fn(),
});
beforeEach(() => {
  syncClock("2030-01-01T10:00:00Z", performance.now(), performance.now());
});
afterEach(() => vi.restoreAllMocks());
function form(p = props()) {
  return render(
    <MemoryRouter>
      <ReservationForm {...p} />
    </MemoryRouter>,
  );
}
async function fill() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Título da reunião"), "Planejamento");
  await user.type(
    screen.getByLabelText("Descrição (opcional)"),
    "Pauta importante",
  );
  return user;
}
describe("reservation form states", () => {
  it("preserves all submitted values after a conflict and refreshes availability without retrying POST", async () => {
    const request = vi
      .spyOn(api, "request")
      .mockRejectedValue(
        new api.ApiError(409, "ROOM_UNAVAILABLE", "Outra reserva venceu."),
      );
    const p = props();
    form(p);
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Confirmar reserva" }));
    expect(await screen.findByRole("alert")).toHaveFocus();
    expect(screen.getByLabelText("Título da reunião")).toHaveValue(
      "Planejamento",
    );
    expect(screen.getByLabelText("Descrição (opcional)")).toHaveValue(
      "Pauta importante",
    );
    expect(screen.getByLabelText("Participantes")).toHaveValue(4);
    expect(screen.getByLabelText("Início da reserva")).toHaveValue(
      p.initialStart.value,
    );
    await user.click(
      screen.getByRole("button", { name: "Atualizar disponibilidade" }),
    );
    expect(p.onRefresh).toHaveBeenCalledWith(p.initialStart, p.initialEnd, "4");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("associates backend validation details with their field", async () => {
    vi.spyOn(api, "request").mockRejectedValue(
      new api.ApiError(400, "VALIDATION_ERROR", "Confira os campos.", {
        title: ["Título inválido."],
      }),
    );
    form();
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Confirmar reserva" }));
    await screen.findByText("Título inválido.");
    expect(screen.getByLabelText("Título da reunião")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(
      screen.getByLabelText("Título da reunião"),
    ).toHaveAccessibleDescription("Título inválido.");
  });
  it("blocks double submission and disables re-send after a transport uncertainty", async () => {
    const request = vi
      .spyOn(api, "request")
      .mockRejectedValue(
        new api.ApiError(
          0,
          "NETWORK_ERROR",
          "A reserva pode ter sido criada.",
          {},
          true,
        ),
      );
    form();
    const user = await fill();
    await user.dblClick(
      screen.getByRole("button", { name: "Confirmar reserva" }),
    );
    await screen.findByText("Não foi possível confirmar o resultado.");
    expect(request).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Confirmar reserva" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("link", { name: "Consultar minhas reservas" }),
    ).toHaveAttribute("href", "/reservations");
  });
  it("shows confirmation and prevents another mutation after success", async () => {
    const request = vi.spyOn(api, "request").mockResolvedValue(reservation);
    form();
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Confirmar reserva" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Reserva confirmada",
    );
    expect(
      screen.getByRole("button", { name: "Confirmar reserva" }),
    ).toBeDisabled();
    expect(request.mock.calls[0][1]).toMatchObject({
      body: { room_id: 1, participants: 4, title: "Planejamento" },
    });
    const body = request.mock.calls[0][1]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("user_id");
    expect(String(body.starts_at)).toMatch(/[+-]\d{2}:\d{2}$/);
  });
  it("recalculates an expired start without changing the title or participants", async () => {
    const refresh = vi
      .spyOn(api, "refreshCsrf")
      .mockImplementation(async () => {
        syncClock("2030-01-01T13:00:00Z", performance.now(), performance.now());
        return { csrf_token: "test", server_now: "2030-01-01T13:00:00Z" };
      });
    const p = props();
    p.initialStart.value = localValue(Date.parse("2030-01-01T09:59:00Z"));
    form(p);
    const user = await fill();
    expect(
      screen.getByRole("button", { name: "Confirmar reserva" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Recalcular horário futuro" }),
    );
    expect(screen.getByLabelText("Título da reunião")).toHaveValue(
      "Planejamento",
    );
    expect(screen.getByLabelText("Participantes")).toHaveValue(4);
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Início da reserva")).toHaveValue(
      localValue(Date.parse("2030-01-01T13:05:00Z")),
    );
    expect(
      screen.getByRole("button", { name: "Confirmar reserva" }),
    ).toBeEnabled();
  });
  it("has accessible form labels and no axe WCAG A/AA violations", async () => {
    const { container } = form();
    const results = await axe.run(container, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
    });
    expect(results.violations).toEqual([]);
  });
});
describe("local date input and cancellation", () => {
  it("shows ambiguous offsets and refuses implicit resolution", () => {
    const input = { value: "2026-11-01T01:30", choice: "" };
    const change = vi.fn();
    render(
      <DateTimeField
        label="Início"
        input={input}
        onChange={change}
        zone="America/New_York"
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Início: escolha o offset" }),
    ).toHaveValue("");
    expect(resolveLocal(input, "America/New_York")).toBeUndefined();
    expect(
      screen.getByRole("option", { name: /UTC−04:00/ }),
    ).toBeInTheDocument();
  });
  it("announces a nonexistent local time", () => {
    render(
      <DateTimeField
        label="Início"
        input={{ value: "2026-03-08T02:30", choice: "" }}
        onChange={vi.fn()}
        zone="America/New_York"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Este horário não existe",
    );
  });
  it("opens cancellation with safe focus and does not mutate when keeping the reservation", async () => {
    const request = vi.spyOn(api, "request");
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <CancelDialog
          reservation={reservation}
          onClose={onClose}
          onCancelled={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("button", { name: "Manter reserva" }),
    ).toHaveFocus();
    expect(
      screen.getByRole("dialog", { name: "Cancelar reserva" }),
    ).toHaveTextContent("Sala Cedro");
    await userEvent.click(
      screen.getByRole("button", { name: "Manter reserva" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });
  it("returns cancellation result and shows cancellation timestamp in the preserved row", async () => {
    const cancelled = {
      ...reservation,
      status: "cancelled" as const,
      cancelled_at: "2030-01-01T10:02:00Z",
    };
    vi.spyOn(api, "request").mockResolvedValue(cancelled);
    const onCancelled = vi.fn();
    const { unmount } = render(
      <MemoryRouter>
        <CancelDialog
          reservation={reservation}
          onClose={vi.fn()}
          onCancelled={onCancelled}
        />
      </MemoryRouter>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Cancelar reserva" }),
    );
    await waitFor(() => expect(onCancelled).toHaveBeenCalledWith(cancelled));
    unmount();
    render(
      <MemoryRouter>
        <BookingRows items={[cancelled]} onCancel={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Cancelada")).toBeInTheDocument();
    expect(screen.getByText(/Cancelada em/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Cancelar/ }),
    ).not.toBeInTheDocument();
  });
  it("handles Escape through the native dialog cancel event", () => {
    const close = vi.fn();
    render(
      <MemoryRouter>
        <CancelDialog
          reservation={reservation}
          onClose={close}
          onCancelled={vi.fn()}
        />
      </MemoryRouter>,
    );
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { bubbles: true, cancelable: true }),
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
describe("room administration", () => {
  it("sends only common room fields, preserving state from dedicated transitions", async () => {
    const request = vi.spyOn(api, "request").mockResolvedValue(room);
    const saved = vi.fn();
    render(
      <MemoryRouter>
        <RoomEditor room={room} onClose={vi.fn()} onSaved={saved} />
      </MemoryRouter>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Salvar alterações" }),
    );
    await waitFor(() => expect(saved).toHaveBeenCalledWith(room));
    const body = request.mock.calls[0][1]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("blocked_reason");
  });
  it("requires preview of affected reservations and presents authoritative post-transition count", async () => {
    const request = vi
      .spyOn(api, "request")
      .mockResolvedValueOnce({
        count: 3,
        results: [],
        next: null,
        previous: null,
      })
      .mockResolvedValueOnce({
        ...room,
        status: "blocked",
        affected_reservations_count: 4,
      });
    const saved = vi.fn();
    render(
      <MemoryRouter>
        <RoomTransition
          room={room}
          action="block"
          onClose={vi.fn()}
          onSaved={saved}
        />
      </MemoryRouter>,
    );
    await screen.findByText(/3 reservas confirmadas/);
    expect(
      screen.getByRole("button", { name: "Manter estado atual" }),
    ).toHaveFocus();
    await userEvent.type(
      screen.getByLabelText("Motivo do bloqueio"),
      "Manutenção",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Bloquear sala" }),
    );
    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith(
        expect.objectContaining({ affected_reservations_count: 4 }),
      ),
    );
    expect(request.mock.calls[0][0]).toContain("not_ended=true");
    expect(request.mock.calls[1][1]).toMatchObject({
      body: { reason: "Manutenção" },
    });
  });
});

describe("admin dialog focus with the real list lifecycle", () => {
  it.each(["Bloquear Sala Cedro", "Editar Sala Cedro"])(
    "returns focus after Escape from %s without removing the trigger through a reload",
    async (triggerName) => {
      const request = vi
        .spyOn(api, "request")
        .mockImplementation(async (path) =>
          path.startsWith("/rooms?")
            ? { count: 1, next: null, previous: null, results: [room] }
            : { count: 0, next: null, previous: null, results: [] },
        );
      render(
        <MemoryRouter>
          <AdminRooms />
        </MemoryRouter>,
      );
      const trigger = await screen.findByRole("button", {
        name: triggerName.startsWith("Bloquear") ? /^Bloquear/ : triggerName,
      });
      await userEvent.click(trigger);
      const dialog = await screen.findByRole("dialog");
      if (triggerName.startsWith("Bloquear"))
        await screen.findByText(/0 reservas confirmadas/);
      fireEvent(
        dialog,
        new Event("cancel", { bubbles: true, cancelable: true }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(trigger).toHaveFocus();
      expect(trigger).toBeInTheDocument();
      expect(
        request.mock.calls.filter(([path]) => path.startsWith("/rooms?")),
      ).toHaveLength(1);
      expect(
        request.mock.calls.some(
          ([, options]) =>
            options?.method === "POST" || options?.method === "PATCH",
        ),
      ).toBe(false);
    },
  );
});
