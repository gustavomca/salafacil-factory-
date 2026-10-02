import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.db import connections
from django.utils import timezone

from audit.models import AuditEvent
from core.serializers import iso
from reservations.models import Reservation
from rooms.models import Room
from tests.base import APITransactionTest


class ReservationAPI(APITransactionTest):
    def test_full_cycle_ownership_history_and_audit(self):
        reservation = self.reserve()
        rid = reservation["id"]
        self.assertNotIn("user", reservation)
        response = self.other_client.get(f"/api/reservations/{rid}")
        self.assert_error(response, 403, "FORBIDDEN")
        self.assertNotIn("Texto privado", response.content.decode())
        self.assert_error(
            self.post(f"/api/reservations/{rid}/cancel", client=self.other_client), 403, "FORBIDDEN"
        )
        self.assertEqual(self.other_client.get("/api/reservations").json()["count"], 0)
        self.assert_error(self.other_client.get("/api/reservations?scope=all"), 403, "FORBIDDEN")
        self.assertEqual(
            self.admin_client.get("/api/reservations?scope=all").json()["results"][0]["user"]["id"],
            self.member.id,
        )
        self.assertEqual(self.admin_client.get("/api/reservations").json()["count"], 0)
        self.assert_error(self.client.get(f"/api/reservations/{uuid.uuid4()}"), 404, "NOT_FOUND")
        response = self.post(f"/api/reservations/{rid}/cancel")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "cancelled")
        second = self.post(f"/api/reservations/{rid}/cancel")
        self.assertEqual(second.json()["cancelled_at"], response.json()["cancelled_at"])
        self.assertEqual(AuditEvent.objects.filter(type="reservation.cancelled").count(), 1)
        self.assertEqual(self.client.get("/api/reservations?status=cancelled").json()["count"], 1)
        self.assertEqual(
            AuditEvent.objects.filter(type="operation.denied", resource_id=rid).count(), 2
        )

    def test_admin_can_cancel_and_current_room_state_remains_visible(self):
        reservation = self.reserve()
        self.post(f"/api/rooms/{self.room.id}/deactivate", client=self.admin_client)
        detail = self.client.get(f"/api/reservations/{reservation['id']}").json()
        self.assertEqual(detail["room"]["status"], "inactive")
        self.assertEqual(
            self.post(
                f"/api/reservations/{reservation['id']}/cancel", client=self.admin_client
            ).status_code,
            200,
        )

    def test_adjacency_overlap_and_cancel_release(self):
        data = self.payload()
        first = self.post("/api/reservations", data)
        self.assertEqual(first.status_code, 201)
        for offset_start, offset_end in [(0, 0), (-30, -30), (30, 30), (-30, 30)]:
            start = timezone.datetime.fromisoformat(
                data["starts_at"].replace("Z", "+00:00")
            ) + timedelta(minutes=offset_start)
            end = timezone.datetime.fromisoformat(
                data["ends_at"].replace("Z", "+00:00")
            ) + timedelta(minutes=offset_end)
            self.assert_error(
                self.post(
                    "/api/reservations", {**data, "starts_at": iso(start), "ends_at": iso(end)}
                ),
                409,
                "ROOM_UNAVAILABLE",
            )
        end = timezone.datetime.fromisoformat(data["ends_at"].replace("Z", "+00:00"))
        self.assertEqual(
            self.post(
                "/api/reservations",
                {**data, "starts_at": iso(end), "ends_at": iso(end + timedelta(minutes=15))},
            ).status_code,
            201,
        )
        self.post(f"/api/reservations/{first.json()['id']}/cancel")
        self.assertEqual(self.post("/api/reservations", data).status_code, 201)

    def test_validation_precedence_and_allowlists(self):
        for extra in [
            {"participants": True},
            {"participants": "3"},
            {"participants": 0},
            {"participants": 101},
            {"title": " "},
            {"title": 12},
            {"room_id": "1"},
            {"starts_at": "2030-01-01T10:00:00"},
            {"starts_at": "Infinity"},
            {"user_id": self.other.id},
            {"role": "admin"},
            {"status": "cancelled"},
            {"actor": self.admin.id},
        ]:
            self.assert_error(
                self.post("/api/reservations", self.payload(**extra)), 400, "VALIDATION_ERROR"
            )
        self.assert_error(
            self.post("/api/reservations", self.payload(room_id=999999, participants=101)),
            400,
            "VALIDATION_ERROR",
        )
        self.assert_error(
            self.post("/api/reservations", self.payload(room_id=999999)), 404, "NOT_FOUND"
        )
        self.room.status = "inactive"
        self.room.save()
        data = self.payload(
            starts_at=iso(timezone.now() - timedelta(minutes=30)),
            ends_at=iso(timezone.now() + timedelta(minutes=30)),
        )
        self.assert_error(self.post("/api/reservations", data), 403, "FORBIDDEN")
        self.assert_error(
            self.post("/api/reservations", data, self.admin_client), 400, "VALIDATION_ERROR"
        )
        self.assert_error(
            self.post("/api/reservations", self.payload(), self.admin_client),
            409,
            "ROOM_UNAVAILABLE",
        )

    def test_duration_boundaries_offsets_and_capacity(self):
        start = timezone.now() + timedelta(days=2)
        for duration, expected in [(14, 400), (15, 201), (480, 201), (481, 400)]:
            data = self.payload(
                starts_at=iso(start), ends_at=iso(start + timedelta(minutes=duration))
            )
            response = self.post("/api/reservations", data)
            self.assertEqual(response.status_code, expected, response.content)
            if expected == 201:
                self.post(f"/api/reservations/{response.json()['id']}/cancel")
        self.assert_error(
            self.post("/api/reservations", self.payload(participants=11)),
            409,
            "ROOM_CAPACITY_CONFLICT",
        )
        self.assert_error(
            self.post(
                "/api/reservations",
                self.payload(
                    starts_at=iso(timezone.now() - timedelta(minutes=1)),
                    ends_at=iso(timezone.now() + timedelta(minutes=30)),
                ),
            ),
            400,
            "VALIDATION_ERROR",
        )
        # The offset changes at midnight, while the real interval remains 30 minutes.
        response = self.post(
            "/api/reservations",
            self.payload(starts_at="2030-01-01T23:45:00-03:00", ends_at="2030-01-02T03:15:00Z"),
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.assertTrue(response.json()["starts_at"].endswith("Z"))

    def test_availability_excludes_unavailable_without_private_data(self):
        data = self.payload(title="SECRET_MEETING", description="SECRET_BODY")
        self.post("/api/reservations", data)
        other = Room.objects.create(name="Livre", capacity=5, location="Piso", status="active")
        Room.objects.create(
            name="Bloqueada", capacity=8, location="Piso", status="blocked", blocked_reason="Obra"
        )
        response = self.other_client.get(
            "/api/availability",
            {"starts_at": data["starts_at"], "ends_at": data["ends_at"], "participants": 3},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual([r["id"] for r in response.json()["results"]], [other.id])
        self.assertNotIn("SECRET", response.content.decode())
        self.assertNotIn("user", response.content.decode())
        self.assertNotIn("reservation", response.content.decode())

    def test_filters_pagination_and_unknown_parameters(self):
        reservation = self.reserve()
        for url in [
            "/api/reservations?page=0",
            "/api/reservations?page=2",
            "/api/reservations?page_size=101",
            "/api/reservations?scope=other",
            "/api/reservations?status=bad",
            "/api/reservations?not_ended=1",
            "/api/reservations?room_id=x",
            "/api/reservations?user_id=1",
            "/api/reservations?status=confirmed&status=cancelled",
        ]:
            self.assert_error(self.client.get(url), 400, "VALIDATION_ERROR")
        self.assertEqual(
            self.client.get("/api/reservations", {"from": reservation["ends_at"]}).json()["count"],
            0,
        )
        self.assertEqual(
            self.client.get("/api/reservations", {"to": reservation["starts_at"]}).json()["count"],
            0,
        )
        self.assertEqual(self.client.get("/api/reservations?not_ended=true").json()["count"], 1)

    def test_not_ended_false_excludes_ongoing_and_future(self):
        now = timezone.now()
        rows = []
        for offset, title in [(-2, "Past"), (0, "Ongoing"), (2, "Future")]:
            start = now + timedelta(hours=offset, minutes=-30)
            rows.append(
                Reservation.objects.create(
                    room=self.room,
                    user=self.member,
                    title=title,
                    starts_at=start,
                    ends_at=start + timedelta(hours=1),
                    participants=2,
                )
            )
        past = self.client.get("/api/reservations?not_ended=false").json()
        self.assertEqual([r["title"] for r in past["results"]], ["Past"])
        current = self.client.get("/api/reservations?not_ended=true").json()
        self.assertEqual({r["title"] for r in current["results"]}, {"Ongoing", "Future"})

    def test_failed_success_audit_rolls_back_and_denied_commits(self):
        with patch(
            "reservations.services.emit", side_effect=RuntimeError("secret SQL must not leak")
        ):
            response = self.post("/api/reservations", self.payload())
        self.assert_error(response, 500, "INTERNAL_ERROR")
        self.assertNotIn("secret", response.content.decode())
        self.assertEqual(Reservation.objects.count(), 0)
        self.reserve()
        denied = self.post("/api/reservations", self.payload())
        self.assert_error(denied, 409, "ROOM_UNAVAILABLE")
        # A second PostgreSQL connection observes the committed denial and only one reservation.
        independent = connections["default"].copy(alias="default")
        try:
            with independent.cursor() as cursor:
                cursor.execute("SELECT count(*) FROM reservations_reservation")
                self.assertEqual(cursor.fetchone()[0], 1)
                cursor.execute("SELECT count(*) FROM audit_auditevent WHERE result='denied'")
                self.assertEqual(cursor.fetchone()[0], 1)
        finally:
            independent.close()


class RoomAPI(APITransactionTest):
    def test_admin_crud_transitions_capacity_and_idempotence(self):
        data = {"name": "Nova", "location": "Piso 2", "capacity": 6, "resources": ["projector"]}
        self.assert_error(self.post("/api/rooms", data), 403, "FORBIDDEN")
        created = self.post("/api/rooms", data, self.admin_client)
        self.assertEqual(created.status_code, 201)
        self.reserve(participants=8)
        room_url = f"/api/rooms/{self.room.id}"
        response = self.admin_client.patch(
            room_url, {"capacity": 7}, content_type="application/json"
        )
        self.assert_error(response, 409, "ROOM_CAPACITY_CONFLICT")
        self.assert_error(
            self.admin_client.patch(
                room_url, {"status": "inactive"}, content_type="application/json"
            ),
            400,
            "VALIDATION_ERROR",
        )
        self.assert_error(
            self.post(room_url + "/block", {"reason": " "}, self.admin_client),
            400,
            "VALIDATION_ERROR",
        )
        response = self.post(room_url + "/block", {"reason": "PRIVATE_REASON"}, self.admin_client)
        self.assertEqual(response.json()["affected_reservations_count"], 1)
        self.assertEqual(Reservation.objects.get().status, "confirmed")
        self.assert_error(self.post("/api/reservations", self.payload()), 409, "ROOM_UNAVAILABLE")
        self.post(room_url + "/block", {"reason": "PRIVATE_REASON"}, self.admin_client)
        self.assertEqual(AuditEvent.objects.filter(type="room.blocked").count(), 1)
        self.post(room_url + "/block", {"reason": "OTHER_REASON"}, self.admin_client)
        self.assertEqual(AuditEvent.objects.filter(type="room.blocked").count(), 2)
        self.post(room_url + "/deactivate", client=self.admin_client)
        self.assert_error(self.client.get(room_url), 403, "FORBIDDEN")
        self.assert_error(
            self.post(room_url + "/block", {"reason": "why"}, self.admin_client),
            409,
            "INVALID_ROOM_STATE",
        )
        self.assert_error(
            self.post(room_url + "/unblock", client=self.admin_client), 409, "INVALID_ROOM_STATE"
        )
        self.post(room_url + "/reactivate", client=self.admin_client)
        self.assertEqual(self.client.get(room_url).json()["blocked_reason"], "")
        metadata = json.dumps(list(AuditEvent.objects.values_list("metadata", flat=True)))
        self.assertNotIn("PRIVATE_REASON", metadata)
        self.assertNotIn("OTHER_REASON", metadata)

    def test_room_filters_validation_and_no_delete(self):
        for extra in [
            {"capacity": 0},
            {"capacity": 101},
            {"capacity": True},
            {"resources": ["invalid-secret"]},
            {"resources": ["projector", "projector"]},
            {"role": "admin"},
            {"blocked_reason": "secret"},
        ]:
            self.assert_error(
                self.post(
                    "/api/rooms",
                    {"name": "Room", "location": "Floor", "capacity": 2, **extra},
                    self.admin_client,
                ),
                400,
                "VALIDATION_ERROR",
            )
        self.assertEqual(
            self.client.get("/api/rooms?resources=whiteboard&capacity=10&search=sal").json()[
                "count"
            ],
            1,
        )
        for query in [
            "resources=unknown",
            "resources=",
            "capacity=0",
            "status=invalid",
            "page_size=0",
            "page=999",
        ]:
            self.assert_error(self.client.get("/api/rooms?" + query), 400, "VALIDATION_ERROR")
        self.assert_error(self.client.get("/api/rooms?status=inactive"), 403, "FORBIDDEN")
        self.assertEqual(self.admin_client.delete(f"/api/rooms/{self.room.id}").status_code, 405)
