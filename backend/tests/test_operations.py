import io
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

from django.conf import settings
from django.contrib.sessions.models import Session
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import IntegrityError, connection, transaction
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from django.utils import timezone

from accounts.models import LoginBucket, User
from audit.models import AuditEvent
from audit.services import clean_metadata
from core.identity import network_key, protected_key
from reservations.models import Reservation
from rooms.models import Room
from tests.base import APITransactionTest
from tests.test_concurrency import isolated


class DashboardAPI(APITransactionTest):
    def test_local_day_dst_lengths_cross_midnight_privacy_and_totals(self):
        # New York spring day is 23 h, fall day is 25 h. Both boundaries are exclusive.
        for day, start, end in [
            ("2030-03-10", "2030-03-10T05:00:00+00:00", "2030-03-11T04:00:00+00:00"),
            ("2030-11-03", "2030-11-03T04:00:00+00:00", "2030-11-04T05:00:00+00:00"),
        ]:
            with self.subTest(day=day):
                start, end = datetime.fromisoformat(start), datetime.fromisoformat(end)
                intervals = [
                    (start - timedelta(minutes=15), start),
                    (start - timedelta(minutes=15), start + timedelta(minutes=15)),
                    (end - timedelta(minutes=15), end + timedelta(minutes=15)),
                    (end, end + timedelta(minutes=15)),
                ]
                for i, (begin, finish) in enumerate(intervals):
                    room = Room.objects.create(name=f"Day {day} {i}", capacity=5, location="Test")
                    Reservation.objects.create(
                        room=room,
                        user=self.member,
                        title=f"Mine {i}",
                        starts_at=begin,
                        ends_at=finish,
                        participants=1,
                    )
                    Reservation.objects.create(
                        room=room,
                        user=self.other,
                        title="OTHER_SECRET",
                        starts_at=begin + timedelta(hours=2),
                        ends_at=finish + timedelta(hours=2),
                        participants=1,
                    )
                response = self.client.get(
                    "/api/dashboard", {"date": day, "tz": "America/New_York"}
                )
                self.assertEqual(response.status_code, 200, response.content)
                self.assertEqual(response.json()["counts"]["my_today"], 2)
                self.assertNotIn("OTHER_SECRET", response.content.decode())
                self.assertNotIn("reservations_today", response.json()["counts"])
                self.assertNotIn("user", response.content.decode())
        for params in [
            {},
            {"date": "bad", "tz": "UTC"},
            {"date": "2030-01-01", "tz": "Unknown/Zone"},
            {"date": "2030-01-01", "tz": "UTC", "scope": "all"},
        ]:
            self.assert_error(self.client.get("/api/dashboard", params), 400, "VALIDATION_ERROR")

    def test_lists_max_five_counts_unlimited_available_now_active_only(self):
        now = timezone.now()
        for i in range(7):
            room = Room.objects.create(name=f"Room {i}", capacity=5, location="Test")
            Reservation.objects.create(
                room=room,
                user=self.admin,
                title=f"Meeting {i}",
                starts_at=now + timedelta(hours=1),
                ends_at=now + timedelta(hours=2),
                participants=1,
            )
        # One ongoing, one blocked room. Ongoing occupies now but is not upcoming.
        Reservation.objects.create(
            room=self.room,
            user=self.admin,
            title="Ongoing",
            starts_at=now - timedelta(minutes=30),
            ends_at=now + timedelta(minutes=30),
            participants=1,
        )
        Room.objects.create(
            name="Blocked",
            capacity=10,
            location="Floor",
            status="blocked",
            blocked_reason="Maintenance",
        )
        response = self.admin_client.get(
            "/api/dashboard", {"date": now.date().isoformat(), "tz": "UTC"}
        ).json()
        self.assertEqual(len(response["upcoming"]), 5)
        self.assertEqual(response["counts"]["my_upcoming"], 7)
        self.assertEqual(response["counts"]["available_now"], 7)
        self.assertEqual(response["counts"]["active_rooms"], 8)
        self.assertEqual(response["counts"]["blocked_rooms"], 1)


class OperatorCommands(TransactionTestCase):
    def test_seed_idempotent_preserves_credentials_rooms_and_refuses_production(self):
        output = io.StringIO()
        call_command("seed_local", stdout=output)
        user = User.objects.get(email="membro@salafacil.local")
        user.set_password("ChangedSecure!Password2030")
        user.is_active = False
        user.save()
        room = Room.objects.get(name="Sala Aurora")
        room.capacity = 37
        room.save()
        call_command("seed_local", stdout=output)
        self.assertEqual(User.objects.count(), 2)
        self.assertEqual(Room.objects.count(), 5)
        user.refresh_from_db()
        room.refresh_from_db()
        self.assertFalse(user.is_active)
        self.assertTrue(user.check_password("ChangedSecure!Password2030"))
        self.assertEqual(room.capacity, 37)
        with override_settings(APP_ENV="production"), self.assertRaises(CommandError):
            call_command("seed_local", stdout=output)
        self.assertEqual(User.objects.count(), 2)

    def test_initial_admin_atomic_idempotent_normalized_and_secret_not_echoed(self):
        output = io.StringIO()
        password = "Initial!AdminPassword2030"
        with patch("sys.stdin", io.StringIO(password + "\n")):
            call_command(
                "provision_initial_admin",
                email=" ADMIN@EXAMPLE.TEST ",
                name=" Admin ",
                password_stdin=True,
                stdout=output,
            )
        user = User.objects.get()
        self.assertEqual(user.email, "admin@example.test")
        self.assertTrue(user.check_password(password))
        event = AuditEvent.objects.get()
        self.assertEqual(event.type, "account.provisioned")
        self.assertIsNone(event.actor_id)
        self.assertEqual(event.resource_id, str(user.pk))
        with patch("sys.stdin", io.StringIO("Other!AdminPassword2030\n")):
            call_command(
                "provision_initial_admin",
                email=user.email,
                name="New Name",
                password_stdin=True,
                stdout=output,
            )
        user.refresh_from_db()
        self.assertTrue(user.check_password(password))
        self.assertEqual(user.name, "Admin")
        self.assertIn("conta existente, senha não alterada", output.getvalue())
        self.assertNotIn(password, output.getvalue())
        with patch("sys.stdin", io.StringIO(password + "\n")), self.assertRaises(CommandError):
            call_command(
                "provision_initial_admin",
                email="different@example.test",
                name="Other",
                password_stdin=True,
                stdout=output,
            )
        self.assertEqual(User.objects.count(), 1)
        self.assertEqual(AuditEvent.objects.count(), 1)

    def test_initial_admin_race_only_one_account_and_audit_rollback(self):
        barrier = Barrier(2, timeout=5)

        def run(email):
            barrier.wait()
            try:
                call_command(
                    "provision_initial_admin", email=email, name="First", stdout=io.StringIO()
                )
                return "created"
            except CommandError:
                return "refused"

        with (
            patch(
                "accounts.management.commands.provision_initial_admin.getpass.getpass",
                return_value="Safe!InitialPassword2030",
            ),
            ThreadPoolExecutor(max_workers=2) as pool,
        ):
            results = [
                f.result(timeout=10)
                for f in [
                    pool.submit(isolated, lambda: run("one@example.test")),
                    pool.submit(isolated, lambda: run("two@example.test")),
                ]
            ]
        self.assertEqual(sorted(results), ["created", "refused"])
        self.assertEqual(User.objects.count(), 1)
        self.assertEqual(AuditEvent.objects.filter(type="account.provisioned").count(), 1)

    def test_initial_audit_failure_does_not_create_account_and_weak_password_refused(self):
        with (
            patch(
                "accounts.management.commands.provision_initial_admin.getpass.getpass",
                return_value="Safe!InitialPassword2030",
            ),
            patch(
                "accounts.management.commands.provision_initial_admin.emit",
                side_effect=RuntimeError("audit unavailable"),
            ),
            self.assertRaises(RuntimeError),
        ):
            call_command(
                "provision_initial_admin",
                email="one@example.test",
                name="First",
                stdout=io.StringIO(),
            )
        self.assertEqual(User.objects.count(), 0)
        with (
            patch(
                "accounts.management.commands.provision_initial_admin.getpass.getpass",
                return_value="password",
            ),
            self.assertRaises(CommandError),
        ):
            call_command(
                "provision_initial_admin",
                email="one@example.test",
                name="First",
                stdout=io.StringIO(),
            )
        self.assertEqual(User.objects.count(), 0)

    def test_maintenance_bounded_old_buckets_only_and_unlock_ipv6(self):
        now = timezone.now()
        for i in range(3):
            Session.objects.create(
                session_key=f"expired{i}", session_data="", expire_date=now - timedelta(hours=1)
            )
            LoginBucket.objects.create(
                kind="ip", key=str(i), window_start=now - timedelta(hours=26), count=1
            )
        Session.objects.create(
            session_key="current", session_data="", expire_date=now + timedelta(hours=1)
        )
        LoginBucket.objects.create(
            kind="ip", key="current", window_start=now - timedelta(hours=23), count=1
        )
        call_command("maintenance", batch_size=2, stdout=io.StringIO())
        self.assertEqual(Session.objects.count(), 2)
        self.assertEqual(LoginBucket.objects.count(), 2)
        self.assertTrue(Session.objects.filter(pk="current").exists())
        self.assertTrue(LoginBucket.objects.filter(key="current").exists())
        identity = protected_key("identity", "x@example.test")
        network = network_key("2001:db8:1::abcd")
        bucket = LoginBucket.objects.create(
            kind="pair",
            key="pair",
            identity_key=identity,
            network_key=network,
            window_start=now,
            count=10,
        )
        call_command(
            "unlock_login",
            network="2001:db8:1::/64",
            reason="SUPPORT_RECOVERY",
            confirm=True,
            stdout=io.StringIO(),
        )
        bucket.refresh_from_db()
        self.assertEqual(bucket.count, 0)
        with self.assertRaises(CommandError):
            call_command(
                "unlock_login",
                identity="x@example.test",
                reason="OWNER_REQUEST",
                stdout=io.StringIO(),
            )
        with self.assertRaises(CommandError):
            call_command(
                "unlock_login",
                network="2001:db8::/32",
                reason="OWNER_REQUEST",
                confirm=True,
                stdout=io.StringIO(),
            )

    def test_database_constraints_independent_of_api(self):
        user = User.objects.create_user(
            email="NORMALIZED@EXAMPLE.TEST", name="User", password="somesafe!password"
        )
        self.assertEqual(user.email, "normalized@example.test")
        with self.assertRaises(IntegrityError), transaction.atomic():
            User.objects.bulk_create([User(email="NORMALIZED@EXAMPLE.TEST", name="Other")])
        room = Room.objects.create(name="Room", capacity=5, location="Floor")
        start = timezone.now()
        defaults = {
            "user": user,
            "room": room,
            "title": "Test",
            "starts_at": start,
            "ends_at": start + timedelta(hours=1),
            "participants": 1,
        }
        for extra in [
            {"participants": 0},
            {"participants": 101},
            {"ends_at": start + timedelta(minutes=14)},
            {"ends_at": start + timedelta(hours=9)},
            {"status": "cancelled"},
            {"status": "bad"},
        ]:
            with self.assertRaises(IntegrityError), transaction.atomic():
                Reservation.objects.create(**{**defaults, **extra})
        for extra in [
            {"capacity": 0},
            {"status": "blocked"},
            {"status": "inactive", "blocked_reason": "must clear"},
            {"status": "bad"},
        ]:
            with self.assertRaises(IntegrityError), transaction.atomic():
                Room.objects.create(
                    **{"name": "Invalid", "location": "Floor", "capacity": 1, **extra}
                )
        with connection.cursor() as cursor:
            cursor.execute("SHOW transaction_isolation")
            self.assertEqual(cursor.fetchone()[0], "read committed")
            cursor.execute("SHOW lock_timeout")
            self.assertEqual(cursor.fetchone()[0], "5s")
        self.assertFalse(settings.DATABASES["default"]["ATOMIC_REQUESTS"])


class Configuration(SimpleTestCase):
    def environment(self):
        return {
            **os.environ,
            "APP_ENV": "production",
            "SECRET_KEY": "tX9&kP4^rB8!mC2@vG6#qH0$sJ5%wL3*nF7-zA1_uE9+dR4=bY8",
            "DEBUG": "false",
            "ALLOWED_HOSTS": "example.test",
            "CSRF_TRUSTED_ORIGINS": "https://example.test:8443",
            "DB_NAME": "app",
            "DB_USER": "app",
            "DB_PASSWORD": "Db!SecurePassword295713",
            "DB_HOST": "db",
        }

    def config(self, env):
        return subprocess.run(
            [
                sys.executable,
                "-c",
                "import config.settings as s; assert s.SESSION_COOKIE_SECURE and s.CSRF_COOKIE_SECURE and s.SECURE_SSL_REDIRECT and not s.DEBUG; assert not s.DATABASES['default']['ATOMIC_REQUESTS']; print('production configuration verified')",
            ],
            env=env,
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
        )

    def test_production_safe_boot_and_rejects_insecure_configuration(self):
        good = self.environment()
        result = self.config(good)
        self.assertEqual(result.returncode, 0, result.stderr)
        for updates in [
            {"APP_ENV": "bad"},
            {"DEBUG": "true"},
            {"SECRET_KEY": "short"},
            {"SECRET_KEY": "x" * 60},
            {"ALLOWED_HOSTS": "*"},
            {"ALLOWED_HOSTS": ""},
            {"CSRF_TRUSTED_ORIGINS": "http://example.test"},
            {"CSRF_TRUSTED_ORIGINS": "https://*.example.test"},
            {"DB_PASSWORD": "LocalDatabase2026"},
            {"DB_HOST": ""},
        ]:
            self.assertNotEqual(self.config({**good, **updates}).returncode, 0, updates)

    def test_metadata_nested_malicious_values_are_never_copied(self):
        result = clean_metadata(
            {
                "request_id": "secret",
                "reason_code": {"password": "SECRET"},
                "previous_status": ["SECRET"],
                "target_kind": {"SECRET": "value"},
                "changed_fields": ["capacity", {"token": "SECRET"}, "SECRET"],
            }
        )
        self.assertEqual(result, {"changed_fields": ["capacity"]})
        self.assertNotIn("SECRET", json.dumps(result))

    def test_log_formatter_never_formats_exception_sql_values(self):
        import logging

        from core.logging import SafeJSONFormatter

        record = logging.LogRecord(
            "db", logging.ERROR, "", 0, "SELECT secret=PASSWORD %s", ("TOKEN",), None
        )
        self.assertNotIn("PASSWORD", SafeJSONFormatter().format(record))
        self.assertNotIn("TOKEN", SafeJSONFormatter().format(record))
