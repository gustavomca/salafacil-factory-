import io
import json
import logging
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.core.management import call_command
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase
from django.utils import timezone

from accounts.models import LocalSeedState, LoginBucket, User
from audit.models import AuditEvent
from core.identity import network_key, window_start
from core.logging import RequestLogDeduplication, SafeJSONFormatter, exception_diagnostics
from reservations.models import Reservation
from rooms.models import Room
from tests import test_concurrency
from tests.base import PASSWORD, APITransactionTest


class SeedRegressions(TransactionTestCase):
    def test_seed_preserves_renamed_rooms_duplicate_names_and_accounts(self):
        call_command("seed_local", stdout=io.StringIO())
        self.assertTrue(LocalSeedState.objects.filter(pk="local_rooms_v1").exists())
        renamed = Room.objects.get(name="Sala Aurora")
        renamed.name = "Nome escolhido pelo administrador"
        renamed.description = "Descrição mantida"
        renamed.save()
        duplicate = Room.objects.create(name="Sala Jardim", capacity=27, location="Usuário")
        before = list(Room.objects.order_by("id").values())
        admin = User.objects.get(email="admin@salafacil.local")
        password_hash = admin.password
        for _ in range(2):
            call_command("seed_local", stdout=io.StringIO())
        self.assertEqual(list(Room.objects.order_by("id").values()), before)
        self.assertFalse(Room.objects.filter(name="Sala Aurora").exists())
        self.assertEqual(Room.objects.filter(name="Sala Jardim").count(), 2)
        duplicate.refresh_from_db()
        self.assertEqual(duplicate.capacity, 27)
        admin.refresh_from_db()
        self.assertEqual(admin.password, password_hash)
        self.assertEqual(LocalSeedState.objects.count(), 1)

    def test_migration_recognizes_populated_legacy_database_without_editing_rooms(self):
        executor = MigrationExecutor(connection)
        executor.migrate([("accounts", "0001_initial")])
        try:
            Room.objects.create(name="Aurora já renomeada", capacity=11, location="Legado")
            Room.objects.create(name="Sala Jardim", capacity=12, location="Legado")
            Room.objects.create(name="Sala Jardim", capacity=13, location="Legado")
            admin = User.objects.create_user(
                email="admin@salafacil.local",
                name="Admin alterado",
                role="admin",
                password=PASSWORD,
            )
            before = list(Room.objects.order_by("id").values())
            MigrationExecutor(connection).migrate([("accounts", "0002_local_seed_state")])
            self.assertTrue(LocalSeedState.objects.filter(pk="local_rooms_v1").exists())
            call_command("seed_local", stdout=io.StringIO())
            self.assertEqual(list(Room.objects.order_by("id").values()), before)
            admin.refresh_from_db()
            self.assertEqual(admin.name, "Admin alterado")
            self.assertTrue(admin.check_password(PASSWORD))
        finally:
            MigrationExecutor(connection).migrate([("accounts", "0002_local_seed_state")])

    def test_seed_failure_rolls_back_marker_and_partial_rooms(self):
        real_create = Room.objects.create
        calls = 0

        def fail_second(**kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("injected failure")
            return real_create(**kwargs)

        with (
            patch(
                "accounts.management.commands.seed_local.Room.objects.create",
                side_effect=fail_second,
            ),
            self.assertRaises(RuntimeError),
        ):
            call_command("seed_local", stdout=io.StringIO())
        self.assertEqual(LocalSeedState.objects.count(), 0)
        self.assertEqual(Room.objects.count(), 0)
        self.assertEqual(User.objects.count(), 0)
        call_command("seed_local", stdout=io.StringIO())
        self.assertEqual(Room.objects.count(), 5)
        self.assertEqual(LocalSeedState.objects.count(), 1)


class O4APIRegressions(APITransactionTest):
    def test_members_cannot_patch_or_transition_rooms_and_denial_identifies_target(self):
        original = {
            "name": self.room.name,
            "capacity": self.room.capacity,
            "status": self.room.status,
            "blocked_reason": self.room.blocked_reason,
        }
        responses = [
            self.client.patch(
                f"/api/rooms/{self.room.pk}", {"capacity": 20}, content_type="application/json"
            )
        ]
        for action in ("block", "unblock", "deactivate", "reactivate"):
            responses.append(
                self.post(
                    f"/api/rooms/{self.room.pk}/{action}",
                    {"reason": "Unauthorized text"} if action == "block" else {},
                )
            )
        for response in responses:
            self.assert_error(response, 403, "FORBIDDEN")
        self.room.refresh_from_db()
        self.assertEqual({field: getattr(self.room, field) for field in original}, original)
        events = AuditEvent.objects.filter(type="operation.denied")
        self.assertEqual(events.count(), 5)
        for event in events:
            self.assertEqual(event.actor_id, self.member.pk)
            self.assertEqual(event.resource, "room")
            self.assertEqual(event.resource_id, str(self.room.pk))
            self.assertEqual(event.metadata["reason_code"], "FORBIDDEN")
            self.assertNotIn("Unauthorized text", json.dumps(event.metadata))
        self.assertEqual(AuditEvent.objects.filter(type__startswith="room.").count(), 0)

    def test_admin_detail_scope_contains_owner_and_member_never_gets_third_party_data(self):
        reservation = self.reserve()
        url = f"/api/reservations/{reservation['id']}"
        admin = self.admin_client.get(url + "?scope=all")
        self.assertEqual(admin.status_code, 200)
        self.assertEqual(
            admin.json()["user"],
            {"id": self.member.pk, "name": self.member.name, "email": self.member.email},
        )
        for client in (self.client, self.admin_client):
            self.assertNotIn("user", client.get(url).json())
            self.assertNotIn("user", client.get(url + "?scope=mine").json())
        self.assert_error(self.client.get(url + "?scope=all"), 403, "FORBIDDEN")
        response = self.other_client.get(url)
        self.assert_error(response, 403, "FORBIDDEN")
        self.assertNotIn(self.member.email, response.content.decode())
        self.assert_error(self.admin_client.get(url + "?scope=invalid"), 400, "VALIDATION_ERROR")

    def test_upcoming_order_is_nearest_first_across_pages_and_history_remains_descending(self):
        now = timezone.now()
        future = []
        for offset in range(1, 24):
            start = now + timedelta(days=offset)
            future.append(
                Reservation.objects.create(
                    room=self.room,
                    user=self.member,
                    title=f"Futura {offset}",
                    starts_at=start,
                    ends_at=start + timedelta(hours=1),
                    participants=1,
                )
            )
        first = self.client.get("/api/reservations?not_ended=true&status=confirmed").json()
        second = self.client.get(first["next"]).json()
        self.assertEqual(first["count"], 23)
        self.assertEqual(
            [r["id"] for r in first["results"] + second["results"]], [str(r.pk) for r in future]
        )
        past = []
        for offset in (-3, -2, -1):
            start = now + timedelta(days=offset)
            past.append(
                Reservation.objects.create(
                    room=self.room,
                    user=self.member,
                    title=f"Passada {offset}",
                    starts_at=start,
                    ends_at=start + timedelta(hours=1),
                    participants=1,
                )
            )
        response = self.client.get("/api/reservations?not_ended=false").json()
        self.assertEqual(
            [r["id"] for r in response["results"]], [str(r.pk) for r in reversed(past)]
        )

    def test_admin_reservations_today_counts_all_owners_ongoing_cross_midnight_not_cancelled(self):
        day = datetime(2031, 1, 2, tzinfo=UTC)
        intervals = [
            (self.admin, day - timedelta(minutes=15), day + timedelta(minutes=15), "confirmed"),
            (self.member, day + timedelta(hours=12), day + timedelta(hours=13), "confirmed"),
            (
                self.other,
                day + timedelta(hours=23, minutes=45),
                day + timedelta(days=1, minutes=15),
                "confirmed",
            ),
            (self.member, day + timedelta(hours=14), day + timedelta(hours=15), "cancelled"),
            (self.other, day - timedelta(minutes=30), day, "confirmed"),
            (self.other, day + timedelta(days=1), day + timedelta(days=1, hours=1), "confirmed"),
        ]
        for index, (user, start, end, status) in enumerate(intervals):
            room = Room.objects.create(name=f"Sala contagem {index}", capacity=5, location="Local")
            Reservation.objects.create(
                room=room,
                user=user,
                title=f"Reserva {index}",
                starts_at=start,
                ends_at=end,
                participants=1,
                status=status,
                cancelled_at=day if status == "cancelled" else None,
            )
        result = self.admin_client.get("/api/dashboard", {"date": "2031-01-02", "tz": "UTC"}).json()
        self.assertEqual(result["counts"]["reservations_today"], 3)
        self.assertEqual(result["counts"]["my_today"], 1)
        self.assertEqual(len(result["today"]), 1)
        for tz in ("America", "../UTC", "/etc/passwd"):
            self.assert_error(
                self.client.get("/api/dashboard", {"date": "2031-01-02", "tz": tz}),
                400,
                "VALIDATION_ERROR",
            )

    def test_processed_login_success_and_failure_logs_have_no_secrets(self):
        client = self.client_for(None, "192.0.2.200")
        with self.assertLogs("salafacil", level="INFO") as captured:
            denied = self.post(
                "/api/session/login",
                {"email": self.member.email, "password": "UNIQUE_DENIED_PASSWORD"},
                client,
            )
            accepted = self.post(
                "/api/session/login", {"email": self.member.email, "password": PASSWORD}, client
            )
        self.assert_error(denied, 401, "INVALID_CREDENTIALS")
        self.assertEqual(accepted.status_code, 200)
        records = [json.loads(SafeJSONFormatter().format(record)) for record in captured.records]
        self.assertEqual({r["status"] for r in records if r["event"] == "http_request"}, {401, 200})
        rendered = json.dumps(records)
        for secret in (
            "UNIQUE_DENIED_PASSWORD",
            PASSWORD,
            self.member.email,
            "192.0.2.200",
            client.cookies["salafacil_session"].value,
            client.defaults["HTTP_X_CSRFTOKEN"],
        ):
            self.assertNotIn(secret, rendered)
        self.assertEqual(AuditEvent.objects.filter(type="login.success").count(), 1)
        self.assertEqual(AuditEvent.objects.filter(type="login.denied").count(), 1)

    def test_unexpected_error_has_safe_correlated_diagnostic_not_exception_values(self):
        def fail_without_exposing_values(*args, **kwargs):
            password = "PASSWORD_IN_LOCAL_VARIABLE"
            raise RuntimeError("SELECT secret_column; token=TOKEN_IN_MESSAGE " + password)

        with (
            patch("reservations.services.emit", side_effect=fail_without_exposing_values),
            self.assertLogs("salafacil", level="INFO") as captured,
        ):
            response = self.post("/api/reservations", self.payload())
        self.assert_error(response, 500, "INTERNAL_ERROR")
        records = [json.loads(SafeJSONFormatter().format(record)) for record in captured.records]
        diagnostic = next(record for record in records if record["event"] == "request_failure")
        self.assertEqual(diagnostic["request_id"], response["X-Request-ID"])
        self.assertEqual(diagnostic["exception_class"], "RuntimeError")
        self.assertEqual(diagnostic["origin_module"], __name__)
        self.assertEqual(diagnostic["origin_function"], "fail_without_exposing_values")
        self.assertGreater(diagnostic["origin_line"], 0)
        self.assertRegex(diagnostic["stack_hash"], r"^[0-9a-f]{64}$")
        for secret in ("PASSWORD_IN_LOCAL_VARIABLE", "TOKEN_IN_MESSAGE", "secret_column", "SELECT"):
            self.assertNotIn(secret, json.dumps(records))
            self.assertNotIn(secret, response.content.decode())
        self.assertEqual(Reservation.objects.count(), 0)

    def test_framework_exception_diagnostics_hash_ignores_values_and_filters_noise(self):
        digests = []
        for value in ("FIRST_SENSITIVE_VALUE", "SECOND_SENSITIVE_VALUE"):
            try:
                raise ValueError(value)
            except ValueError as exc:
                diagnostic = exception_diagnostics(exc)
                record = logging.LogRecord(
                    "django.request",
                    logging.ERROR,
                    "",
                    0,
                    value,
                    (),
                    (type(exc), exc, exc.__traceback__),
                )
                record.request = SimpleNamespace(request_id="fa028136-6374-47c3-89c1-4b42b9bfe40")
                rendered = json.loads(SafeJSONFormatter().format(record))
                self.assertNotIn(value, json.dumps(rendered))
                self.assertEqual(rendered["request_id"], record.request.request_id)
                self.assertTrue(RequestLogDeduplication().filter(record))
                digests.append(diagnostic["stack_hash"])
        self.assertEqual(digests[0], digests[1])
        record.exc_info = None
        self.assertFalse(RequestLogDeduplication().filter(record))


class LoginStateBoundRegressions(APITransactionTest):
    race = test_concurrency.Concurrency.race

    @patch("accounts.services.window_start")
    def test_real_sixty_ip_attempts_then_sequential_and_concurrent_unique_identities_do_not_grow_state(
        self,
        fixed_window,
    ):
        # Keep this quota test in one window even when the wall clock crosses its boundary.
        fixed_window.return_value = window_start(timezone.now())
        client = self.client_for(None, "192.0.2.210")
        for index in range(60):
            response = self.post(
                "/api/session/login",
                {"email": f"quota-{index % 6}@example.test", "password": "wrong"},
                client,
            )
            self.assert_error(response, 401, "INVALID_CREDENTIALS")
        network = network_key("192.0.2.210")
        self.assertEqual(LoginBucket.objects.get(kind="ip", network_key=network).count, 60)
        before = LoginBucket.objects.count()
        for index in range(15):
            response = self.post(
                "/api/session/login",
                {"email": f"blocked-{index}@example.test", "password": "wrong"},
                client,
            )
            self.assert_error(response, 429, "LOGIN_RATE_LIMITED")
        clients = [self.client_for(None, "192.0.2.210") for _ in range(8)]
        with (
            patch(
                "accounts.services.protected_key",
                side_effect=AssertionError("blocked IP must not derive identity keys"),
            ),
            patch(
                "accounts.services.User.objects.filter",
                side_effect=AssertionError("blocked IP must not query accounts"),
            ),
        ):
            responses = self.race(
                [
                    lambda c=c, i=i: self.post(
                        "/api/session/login",
                        {"email": f"burst-{i}@example.test", "password": "wrong"},
                        c,
                    )
                    for i, c in enumerate(clients)
                ]
            )
        self.assertEqual([response.status_code for response in responses], [429] * 8)
        self.assertEqual(LoginBucket.objects.count(), before)
        self.assertEqual(LoginBucket.objects.get(kind="ip", network_key=network).count, 60)
        self.assertEqual(
            sum(AuditEvent.objects.filter(type="login.denied").values_list("count", flat=True)), 83
        )

    def test_different_networks_same_identity_stay_within_global_cap_without_deadlock(self):
        left = self.client_for(None, "192.0.2.221")
        right = self.client_for(None, "192.0.2.222")
        body = {"email": self.member.email, "password": "wrong"}
        self.post("/api/session/login", body, left)
        LoginBucket.objects.filter(kind="identity").update(count=99)
        responses = self.race(
            [
                lambda: self.post("/api/session/login", body, left),
                lambda: self.post("/api/session/login", body, right),
            ],
            "accounts.services.locked_buckets",
        )
        self.assertEqual(sorted(r.status_code for r in responses), [401, 429])
        self.assertEqual(LoginBucket.objects.get(kind="identity").count, 100)

    def test_login_identity_unlock_and_network_unlock_share_deadlock_free_order(self):
        left = self.client_for(None, "192.0.2.231")
        right = self.client_for(None, "192.0.2.232")
        body = {"email": self.member.email, "password": "wrong"}
        self.post("/api/session/login", body, left)
        self.post("/api/session/login", body, right)
        calls = [
            lambda: self.post("/api/session/login", body, left),
            lambda: self.post("/api/session/login", body, right),
            lambda: call_command(
                "unlock_login",
                identity=self.member.email,
                reason="SUPPORT_RECOVERY",
                confirm=True,
                stdout=io.StringIO(),
            ),
            lambda: call_command(
                "unlock_login",
                network="192.0.2.231",
                reason="SUPPORT_RECOVERY",
                confirm=True,
                stdout=io.StringIO(),
            ),
        ]
        results = self.race(calls)
        self.assertEqual([response.status_code for response in results[:2]], [401, 401])
        self.assertEqual(results[2:], [None, None])
        self.assertEqual(
            LoginBucket.objects.get(kind="ip", network_key=network_key("192.0.2.232")).count, 2
        )
        self.assertEqual(AuditEvent.objects.filter(type="login.limit_unlocked").count(), 2)
