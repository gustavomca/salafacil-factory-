export type Role = "admin" | "member";
export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
}
export type Resource = "projector" | "whiteboard" | "videoconference";
export type RoomStatus = "active" | "blocked" | "inactive";
export interface Room {
  id: number;
  name: string;
  description: string;
  capacity: number;
  location: string;
  resources: Resource[];
  status: RoomStatus;
  blocked_reason: string;
  created_at: string;
  updated_at: string;
  affected_reservations_count?: number;
}
export interface Reservation {
  id: string;
  room: Pick<
    Room,
    "id" | "name" | "status" | "capacity" | "location" | "blocked_reason"
  >;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
  participants: number;
  status: "confirmed" | "cancelled";
  created_at: string;
  cancelled_at: string | null;
  user?: User;
}
export interface Page<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}
export interface Dashboard {
  server_now: string;
  date: string;
  tz: string;
  upcoming: Reservation[];
  today: Reservation[];
  counts: {
    available_now: number;
    my_today: number;
    my_upcoming: number;
    active_rooms?: number;
    blocked_rooms?: number;
    reservations_today?: number;
  };
}
export interface AuditEvent {
  id: number;
  type: string;
  first_at: string;
  last_at: string;
  count: number;
  actor: { id: number; name: string } | null;
  resource: string;
  resource_id: string | null;
  result: "success" | "denied";
  metadata: Record<string, unknown>;
}
export interface AuditPage {
  results: AuditEvent[];
  next_cursor: string | null;
  has_more: boolean;
}
export const resources: Record<Resource, string> = {
  projector: "Projetor",
  whiteboard: "Quadro branco",
  videoconference: "Videoconferência",
};
