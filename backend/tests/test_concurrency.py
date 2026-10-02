import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.db import IntegrityError, connection, connections, transaction
from django.utils import timezone

from accounts.models import LoginBucket
from audit.models import AuditEvent
from audit.services import emit
from core.identity import network_key, window_start
from reservations.models import Reservation
from rooms.models import Room
from tests.base import APITransactionTest


def isolated(call):
    connections.close_all()
    try:
        return call()
    finally:
        connections.close_all()


class Concurrency(APITransactionTest):
    def race(self, calls, patch_target=None):
        barrier = threading.Barrier(len(calls), timeout=5)
        if patch_target:
            import importlib

            module, attribute = patch_target.rsplit(".", 1)
            real = getattr(importlib.import_module(module), attribute)

            def before_lock(*args, **kwargs):
                barrier.wait()
                return real(*args, **kwargs)

            with (
                patch(patch_target, side_effect=before_lock),
                ThreadPoolExecutor(max_workers=len(calls)) as pool,
            ):
                futures = [pool.submit(isolated, call) for call in calls]
                return [future.result(timeout=12) for future in futures]

        def synchronized(call):
            barrier.wait()
            return call()

        with ThreadPoolExecutor(max_workers=len(calls)) as pool:
            return [
                future.result(timeout=12)
                for future in [
                    pool.submit(isolated, lambda c=call: synchronized(c)) for call in calls
                ]
            ]

    def observe_waiter(self, call, action, room=None):
        """Hold a real row lock, observe pg_stat_activity before allowing the winner to commit."""
        pid_queue = queue.Queue()

        def worker():
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                pid_queue.put(cursor.fetchone()[0])
            return call()

        with ThreadPoolExecutor(max_workers=1) as pool:
            with transaction.atomic():
                Room.objects.select_for_update().get(pk=(room or self.room).pk)
                future = pool.submit(isolated, worker)
                pid = pid_queue.get(timeout=3)
                deadline = time.monotonic() + 3
                observed = False
                while time.monotonic() < deadline:
                    with connection.cursor() as cursor:
                        cursor.execute("SELECT pg_stat_clear_snapshot()")
                        cursor.execute(
                            "SELECT wait_event_type FROM pg_stat_activity WHERE pid=%s", [pid]
                        )
                        row = cursor.fetchone()
                    if row and row[0] == "Lock":
                        observed = True
                        break
                    threading.Event().wait(0.01)
                self.assertTrue(
                    observed, "Independent backend never demonstrably waited for a PostgreSQL lock"
                )
                winner = action()
            loser = future.result(timeout=8)
        return winner, loser

    def test_real_concurrent_http_reservations_one_winner_one_conflict(self):
        data = self.payload()
        responses = self.race(
            [
                lambda data=data: self.post("/api/reservations", data, self.client),
                lambda: self.post("/api/reservations", data, self.other_client),
            ],
            "reservations.services.locked_room",
        )
        self.assertEqual(sorted(x.status_code for x in responses), [201, 409])
        self.assertEqual(Reservation.objects.filter(status="confirmed").count(), 1)
        self.assertEqual(AuditEvent.objects.filter(type="reservation.created").count(), 1)
        self.assertEqual(AuditEvent.objects.filter(result="denied").count(), 1)

    def test_constraint_blocks_independent_direct_inserts_without_service(self):
        start = timezone.now() + timedelta(days=1)
        data = {
            "room_id": self.room.pk,
            "user_id": self.member.pk,
            "title": "Direct",
            "starts_at": start,
            "ends_at": start + timedelta(hours=1),
            "participants": 2,
        }

        def insert():
            try:
                with transaction.atomic():
                    Reservation.objects.create(**data)
                return "created"
            except IntegrityError as exc:
                return exc.__cause__.diag.constraint_name

        # A completed insert stays uncommitted while an independent insert waits on
        # its exclusion constraint. This avoids a legitimate symmetric GiST deadlock
        # while proving the database guard without invoking the Room-lock service.
        pid_queue = queue.Queue()

        def waiter():
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                pid_queue.put(cursor.fetchone()[0])
            return insert()

        with ThreadPoolExecutor(max_workers=1) as pool:
            with transaction.atomic():
                Reservation.objects.create(**data)
                future = pool.submit(isolated, waiter)
                pid = pid_queue.get(timeout=3)
                deadline = time.monotonic() + 3
                observed = False
                while time.monotonic() < deadline:
                    with connection.cursor() as cursor:
                        cursor.execute("SELECT pg_stat_clear_snapshot()")
                        cursor.execute(
                            "SELECT wait_event_type FROM pg_stat_activity WHERE pid=%s", [pid]
                        )
                        row = cursor.fetchone()
                    if row and row[0] == "Lock":
                        observed = True
                        break
                    threading.Event().wait(0.01)
                self.assertTrue(observed)
            self.assertEqual(future.result(timeout=5), "reservation_no_overlap")
        self.assertEqual(Reservation.objects.count(), 1)

    def test_block_and_deactivate_win_and_create_win_preserves_reservation(self):
        for action in ("block", "deactivate"):
            with self.subTest(action=action):
                data = self.payload()
                payload = {"reason": "Manutenção"} if action == "block" else {}
                winner, loser = self.observe_waiter(
                    lambda data=data: self.post("/api/reservations", data, self.client),
                    lambda action=action, payload=payload: self.post(
                        f"/api/rooms/{self.room.pk}/{action}", payload, self.admin_client
                    ),
                )
                self.assertEqual(winner.status_code, 200)
                self.assertEqual(loser.status_code, 409 if action == "block" else 403)
                self.assertEqual(Reservation.objects.count(), 0)
                self.post(
                    f"/api/rooms/{self.room.pk}/{'unblock' if action == 'block' else 'reactivate'}",
                    client=self.admin_client,
                )
                winner, loser = self.observe_waiter(
                    lambda action=action, payload=payload: self.post(
                        f"/api/rooms/{self.room.pk}/{action}", payload, self.admin_client
                    ),
                    lambda data=data: self.post("/api/reservations", data, self.client),
                )
                self.assertEqual(winner.status_code, 201)
                self.assertEqual(loser.status_code, 200)
                self.assertEqual(loser.json()["affected_reservations_count"], 1)
                self.assertEqual(Reservation.objects.get().status, "confirmed")
                self.post(f"/api/reservations/{winner.json()['id']}/cancel", client=self.client)
                self.post(
                    f"/api/rooms/{self.room.pk}/{'unblock' if action == 'block' else 'reactivate'}",
                    client=self.admin_client,
                )
                # Preserve history while ensuring the next branch's count assertion is scoped.
                Reservation.objects.all().delete()

    def test_capacity_and_create_both_orders_under_observed_lock(self):
        data = self.payload(participants=8)

        def update():
            return self.admin_client.patch(
                f"/api/rooms/{self.room.pk}", {"capacity": 5}, content_type="application/json"
            )

        winner, loser = self.observe_waiter(lambda: self.post("/api/reservations", data), update)
        self.assertEqual(winner.status_code, 200)
        self.assert_error(loser, 409, "ROOM_CAPACITY_CONFLICT")
        self.admin_client.patch(
            f"/api/rooms/{self.room.pk}", {"capacity": 10}, content_type="application/json"
        )
        winner, loser = self.observe_waiter(update, lambda: self.post("/api/reservations", data))
        self.assertEqual(winner.status_code, 201)
        self.assert_error(loser, 409, "ROOM_CAPACITY_CONFLICT")
        self.room.refresh_from_db()
        self.assertEqual(self.room.capacity, 10)

    def test_cancellation_is_idempotent_under_concurrency_and_frees_after_commit(self):
        data = self.payload()
        rid = self.post("/api/reservations", data).json()["id"]
        # Separate sessions/clients, same authenticated owner.
        second_client = self.client_for(self.member, "192.0.2.2")
        responses = self.race(
            [
                lambda: self.post(f"/api/reservations/{rid}/cancel"),
                lambda: self.post(f"/api/reservations/{rid}/cancel", client=second_client),
            ],
            "reservations.services.locked_room",
        )
        self.assertEqual([r.status_code for r in responses], [200, 200])
        self.assertEqual(AuditEvent.objects.filter(type="reservation.cancelled").count(), 1)
        rid = self.post("/api/reservations", data).json()["id"]
        winner, loser = self.observe_waiter(
            lambda: self.post("/api/reservations", data, self.other_client),
            lambda: self.post(f"/api/reservations/{rid}/cancel"),
        )
        self.assertEqual(winner.status_code, 200)
        self.assertEqual(loser.status_code, 201)
        self.assertEqual(Reservation.objects.filter(status="confirmed").count(), 1)

    def test_different_rooms_do_not_share_global_lock(self):
        other_room = Room.objects.create(name="Other", capacity=4, location="Other")
        data = self.payload(room=other_room)
        with ThreadPoolExecutor(max_workers=1) as pool, transaction.atomic():
            Room.objects.select_for_update().get(pk=self.room.pk)
            response = pool.submit(isolated, lambda: self.post("/api/reservations", data)).result(
                timeout=3
            )
            self.assertEqual(response.status_code, 201)

    def test_login_race_does_not_exceed_pair_ip_or_identity_caps(self):
        from accounts.services import LIMITS

        for kind in ("pair", "ip", "identity"):
            with self.subTest(kind=kind):
                LoginBucket.objects.all().delete()
                left = self.client_for(None, "192.0.2.120")
                right = self.client_for(None, "192.0.2.120")
                data = {"email": self.member.email, "password": "invalid"}
                self.post("/api/session/login", data, left)
                LoginBucket.objects.filter(kind=kind).update(count=LIMITS[kind] - 1)
                responses = self.race(
                    [
                        lambda data=data, left=left: self.post("/api/session/login", data, left),
                        lambda data=data, right=right: self.post("/api/session/login", data, right),
                    ],
                    "accounts.services.locked_buckets",
                )
                self.assertEqual(sorted(r.status_code for r in responses), [401, 429])
                self.assertEqual(LoginBucket.objects.get(kind=kind).count, LIMITS[kind])

    def test_concurrent_anonymous_denials_exact_group_count(self):
        clients = [self.client_for(None, f"2001:db8:42::{i + 1}") for i in range(6)]
        responses = self.race([lambda client=c: client.get("/api/reservations") for c in clients])
        self.assertEqual([r.status_code for r in responses], [401] * 6)
        event = AuditEvent.objects.get(type="operation.denied")
        self.assertEqual(event.count, 6)
        self.assertIsNone(event.actor_id)
        self.assertIsNone(event.resource_id)
        self.assertIsNotNone(event.aggregation_key)

    def test_aggregation_preserves_first_last_under_late_commit(self):
        now = window_start(timezone.now()) + timedelta(minutes=2)
        context = SimpleNamespace(
            request_id="5fd681b0-92b3-4496-9a7e-c57e9a308e6a",
            network_key=network_key("192.0.2.8"),
            resolver_match=SimpleNamespace(url_name="rooms"),
        )
        for instant in [now, now + timedelta(seconds=2), now + timedelta(seconds=1)]:
            emit(
                "operation.denied",
                context=context,
                aggregate=True,
                result="denied",
                metadata={"reason_code": "AUTH_REQUIRED"},
                now=instant,
            )
        event = AuditEvent.objects.get()
        self.assertEqual(event.first_at, now)
        self.assertEqual(event.last_at, now + timedelta(seconds=2))
        self.assertEqual(event.count, 3)

    def test_lock_timeout_is_five_seconds_and_returns_retry_later(self):
        data = self.payload()
        with ThreadPoolExecutor(max_workers=1) as pool, transaction.atomic():
            Room.objects.select_for_update().get(pk=self.room.pk)
            started = time.monotonic()
            response = pool.submit(isolated, lambda: self.post("/api/reservations", data)).result(
                timeout=8
            )
            elapsed = time.monotonic() - started
        self.assert_error(response, 503, "RETRY_LATER")
        self.assertGreaterEqual(elapsed, 4.9)
        self.assertLess(elapsed, 7.5)
        self.assertEqual(Reservation.objects.count(), 0)

    def test_server_rechecks_start_after_observed_lock_wait(self):
        from core.serializers import iso

        now = timezone.now()
        data = self.payload(
            starts_at=iso(now + timedelta(minutes=5)), ends_at=iso(now + timedelta(minutes=65))
        )
        with patch("reservations.services.timezone.now", return_value=now) as clock:

            def advance_time():
                clock.return_value = now + timedelta(minutes=6)

            _, response = self.observe_waiter(
                lambda: self.post("/api/reservations", data), advance_time
            )
        self.assert_error(response, 400, "VALIDATION_ERROR")
        self.assertIn("starts_at", response.json()["error"]["details"])
        self.assertEqual(Reservation.objects.count(), 0)
