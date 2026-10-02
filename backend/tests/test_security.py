import io
import json
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.conf import settings
from django.contrib.sessions.models import Session
from django.core.management import call_command
from django.db import DatabaseError, connections
from django.test import Client
from django.utils import timezone

from accounts.models import LoginBucket
from audit.models import AuditEvent
from audit.services import emit
from core.identity import network_key
from core.serializers import iso
from tests.base import PASSWORD, APITransactionTest


class SessionSecurity(APITransactionTest):
    def login(self, client, email=None, password=PASSWORD):
        return self.post(
            "/api/session/login",
            {"email": email or self.member.email, "password": password},
            client,
        )

    def test_login_rotates_session_and_csrf_persists_absolute_expiry_logout(self):
        client = self.client_for()
        before_token = client.defaults["HTTP_X_CSRFTOKEN"]
        response = self.login(client, "  MEMBER@EXAMPLE.TEST  ")
        self.assertEqual(response.status_code, 200, response.content)
        cookie = response.cookies[settings.SESSION_COOKIE_NAME]
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["samesite"], "Lax")
        self.assertEqual(cookie["path"], "/")
        self.assertEqual(cookie["domain"], "")
        old_key = cookie.value
        stored = Session.objects.get(pk=old_key)
        initial_expiry = stored.expire_date
        self.assertAlmostEqual((initial_expiry - timezone.now()).total_seconds(), 8 * 3600, delta=2)
        session = client.session
        session["unrelated"] = "later write"
        session.save()
        self.assertEqual(Session.objects.get(pk=old_key).expire_date, initial_expiry)
        self.assertEqual(client.get("/api/session/me").json()["user"]["id"], self.member.id)
        self.assert_error(self.post("/api/session/logout", client=client), 403, "CSRF_FAILED")
        token = client.get("/api/session/csrf").json()["csrf_token"]
        self.assertNotEqual(token, before_token)
        client.defaults["HTTP_X_CSRFTOKEN"] = token
        self.assertEqual(self.post("/api/session/logout", client=client).status_code, 204)
        self.assertFalse(Session.objects.filter(pk=old_key).exists())
        self.assertEqual(client.get("/api/session/me").json(), {"user": None})
        self.assert_error(self.post("/api/session/logout", client=client), 401, "AUTH_REQUIRED")
        client.cookies[settings.SESSION_COOKIE_NAME] = old_key
        self.assert_error(client.get("/api/reservations"), 401, "AUTH_REQUIRED")

    def test_relogin_rotates_an_existing_authenticated_session(self):
        client = self.client_for()
        self.assertEqual(self.login(client).status_code, 200)
        original = client.cookies[settings.SESSION_COOKIE_NAME].value
        client.defaults["HTTP_X_CSRFTOKEN"] = client.get("/api/session/csrf").json()["csrf_token"]
        self.assertEqual(self.login(client).status_code, 200)
        rotated = client.cookies[settings.SESSION_COOKIE_NAME].value
        self.assertNotEqual(original, rotated)
        self.assertFalse(Session.objects.filter(pk=original).exists())
        self.assertTrue(Session.objects.filter(pk=rotated).exists())

    def test_invalid_unknown_inactive_are_generic_and_expired_sessions_rejected(self):
        client = self.client_for()
        unknown = self.login(client, "missing@example.test", "wrong")
        invalid = self.login(client, password="wrong")
        self.member.is_active = False
        self.member.save(update_fields=["is_active"])
        inactive = self.login(client)
        for response in (unknown, invalid, inactive):
            self.assert_error(response, 401, "INVALID_CREDENTIALS")
        self.assertEqual(unknown.json(), inactive.json())
        self.assert_error(self.client.get("/api/rooms"), 401, "AUTH_REQUIRED")
        self.member.is_active = True
        self.member.save(update_fields=["is_active"])
        self.login(client)
        Session.objects.filter(pk=client.cookies[settings.SESSION_COOKIE_NAME].value).update(
            expire_date=timezone.now() - timedelta(seconds=1)
        )
        self.assert_error(client.get("/api/rooms"), 401, "AUTH_REQUIRED")

    def test_csrf_anonymous_origin_protected_mutation_and_secret_safe_logs(self):
        anon = Client(enforce_csrf_checks=True, HTTP_X_FORWARDED_FOR="192.0.2.2")
        with self.assertLogs("salafacil", level="INFO") as logs:
            response = self.login(anon, password="not-logged-password")
        self.assert_error(response, 403, "CSRF_FAILED")
        self.assertNotIn("not-logged-password", json.dumps(logs.output))
        client = self.client_for()
        self.assert_error(
            client.post(
                "/api/session/login",
                {"email": self.member.email, "password": PASSWORD},
                content_type="application/json",
                HTTP_ORIGIN="https://evil.test",
            ),
            403,
            "CSRF_FAILED",
        )
        token = self.client.defaults.pop("HTTP_X_CSRFTOKEN")
        self.assert_error(self.post("/api/reservations", self.payload()), 403, "CSRF_FAILED")
        self.client.defaults["HTTP_X_CSRFTOKEN"] = token
        self.assertFalse(AuditEvent.objects.filter(metadata__icontains=PASSWORD).exists())

    def test_public_state_no_false_denial_and_401_aggregation_routes(self):
        client = self.client_for(None, "2001:db8:abcd:1::1")
        before = AuditEvent.objects.count()
        for _ in range(3):
            self.assertEqual(client.get("/api/session/me").json(), {"user": None})
        self.assertEqual(AuditEvent.objects.count(), before)
        for i in range(6):
            client.defaults["HTTP_X_FORWARDED_FOR"] = f"2001:db8:abcd:1::{i + 1}"
            self.assert_error(
                client.get(f"/api/reservations/{__import__('uuid').uuid4()}"), 401, "AUTH_REQUIRED"
            )
        grouped = AuditEvent.objects.get(type="operation.denied", result="denied")
        self.assertEqual(grouped.count, 6)
        self.assertIsNone(grouped.actor_id)
        self.assertIsNone(grouped.resource_id)
        self.assertEqual(grouped.resource, "http")
        self.assertIsNotNone(grouped.aggregation_key)
        self.assert_error(client.get("/api/rooms"), 401, "AUTH_REQUIRED")
        self.assertEqual(AuditEvent.objects.count(), before + 2)

    def test_proxy_identity_strict_and_mapped_ipv4(self):
        for address in [None, "", "192.0.2.1, 192.0.2.2", "no", "192.0.2.1 ", "fe80::1%eth0"]:
            client = Client(enforce_csrf_checks=True)
            extra = {"HTTP_X_FORWARDED_FOR": address} if address is not None else {}
            self.assert_error(
                client.get("/api/session/csrf", **extra), 503, "PROXY_IDENTITY_INVALID"
            )
        self.assertEqual(network_key("::ffff:192.0.2.1"), network_key("192.0.2.1"))
        self.assertEqual(network_key("2001:db8:1::1234"), network_key("2001:db8:1::5678"))
        self.assertNotEqual(network_key("2001:db8:1::1"), network_key("2001:db8:2::1"))
        self.assertEqual(Client().get("/health/live").status_code, 200)
        self.assertEqual(Client().get("/health/ready").status_code, 200)

    def test_failed_audit_rolls_back_session_and_logout(self):
        client = self.client_for()
        sessions_before = Session.objects.count()
        with patch("accounts.services.emit", side_effect=DatabaseError("SECRET_DETAIL")):
            response = self.login(client)
        self.assert_error(response, 503, "SERVICE_UNAVAILABLE")
        self.assertNotIn("SECRET_DETAIL", response.content.decode())
        self.assertEqual(Session.objects.count(), sessions_before)
        self.assertEqual(LoginBucket.objects.count(), 0)
        self.assertEqual(client.get("/api/session/me").json(), {"user": None})
        self.login(client)
        client.defaults["HTTP_X_CSRFTOKEN"] = client.get("/api/session/csrf").json()["csrf_token"]
        key = client.cookies[settings.SESSION_COOKIE_NAME].value
        with patch("accounts.services.emit", side_effect=DatabaseError("failure")):
            response = self.post("/api/session/logout", client=client)
        self.assert_error(response, 503, "SERVICE_UNAVAILABLE")
        self.assertTrue(Session.objects.filter(pk=key).exists())
        self.assertEqual(client.get("/api/session/me").json()["user"]["id"], self.member.id)

    def test_json_errors_size_and_secrets_rejected(self):
        for content in ["{", "[]", "null"]:
            self.assert_error(
                self.client.post("/api/reservations", content, content_type="application/json"),
                400,
                "VALIDATION_ERROR",
            )
        self.assert_error(
            self.post("/api/reservations", self.payload(description="a" * 33000)),
            400,
            "VALIDATION_ERROR",
        )
        self.assert_error(
            self.post(
                "/api/session/login",
                {"email": self.member.email, "password": "a" * 129},
                self.client_for(),
            ),
            400,
            "VALIDATION_ERROR",
        )
        self.assert_error(
            self.post(
                "/api/session/login",
                {"email": self.member.email, "password": PASSWORD, "role": "admin"},
                self.client_for(),
            ),
            400,
            "VALIDATION_ERROR",
        )


class LoginLimits(APITransactionTest):
    def test_pair_real_limit_counts_commit_and_other_ip_has_budget(self):
        client = self.client_for(None, "192.0.2.30")
        for _i in range(10):
            response = self.post(
                "/api/session/login",
                {"email": " MeMbEr@example.test ", "password": "wrong"},
                client,
            )
            self.assert_error(response, 401, "INVALID_CREDENTIALS")
        for _ in range(3):
            response = self.post(
                "/api/session/login", {"email": self.member.email, "password": PASSWORD}, client
            )
            self.assert_error(response, 429, "LOGIN_RATE_LIMITED")
            self.assertGreater(int(response["Retry-After"]), 0)
            self.assertLessEqual(int(response["Retry-After"]), 901)
        self.assertEqual(LoginBucket.objects.get(kind="pair").count, 10)
        self.assertEqual(LoginBucket.objects.get(kind="identity").count, 10)
        self.assertEqual(LoginBucket.objects.get(kind="ip").count, 13)
        denied = AuditEvent.objects.filter(type="login.denied")
        self.assertEqual(sum(denied.values_list("count", flat=True)), 13)
        self.assertEqual(denied.count(), 2)
        other = self.client_for(None, "192.0.2.31")
        self.assertEqual(
            self.post(
                "/api/session/login", {"email": self.member.email, "password": PASSWORD}, other
            ).status_code,
            200,
        )
        self.assertEqual(LoginBucket.objects.get(kind="identity").count, 10)
        independent = connections["default"].copy(alias="default")
        try:
            with independent.cursor() as cursor:
                cursor.execute("SELECT count FROM accounts_loginbucket WHERE kind='identity'")
                self.assertEqual(cursor.fetchone()[0], 10)
        finally:
            independent.close()

    def test_ip_and_identity_boundaries_no_hash_above_limit_and_unlock_selective(self):
        first = self.client_for(None, "192.0.2.40")
        data = {"email": self.member.email, "password": "wrong"}
        self.post("/api/session/login", data, first)
        LoginBucket.objects.filter(kind="ip").update(count=59)
        self.assert_error(self.post("/api/session/login", data, first), 401, "INVALID_CREDENTIALS")
        with patch(
            "accounts.models.User.check_password", side_effect=AssertionError("must not hash")
        ):
            self.assert_error(
                self.post("/api/session/login", data, first), 429, "LOGIN_RATE_LIMITED"
            )
        LoginBucket.objects.filter(kind="identity").update(count=99)
        second = self.client_for(None, "192.0.2.41")
        self.assert_error(self.post("/api/session/login", data, second), 401, "INVALID_CREDENTIALS")
        self.assertEqual(LoginBucket.objects.get(kind="identity").count, 100)
        third = self.client_for(None, "192.0.2.42")
        with patch(
            "accounts.models.User.objects.filter",
            side_effect=AssertionError("no identity query above limit"),
        ):
            self.assert_error(
                self.post("/api/session/login", data, third), 429, "LOGIN_RATE_LIMITED"
            )
        call_command(
            "unlock_login",
            identity="MEMBER@EXAMPLE.TEST",
            reason="OWNER_REQUEST",
            confirm=True,
            stdout=io.StringIO(),
        )
        self.assertEqual(
            LoginBucket.objects.get(kind="ip", network_key=network_key("192.0.2.40")).count, 60
        )
        self.assertEqual(LoginBucket.objects.get(kind="identity").count, 0)
        call_command(
            "unlock_login",
            network="192.0.2.40",
            reason="SECURITY_RESPONSE",
            confirm=True,
            stdout=io.StringIO(),
        )
        self.assertEqual(
            LoginBucket.objects.get(kind="ip", network_key=network_key("192.0.2.40")).count, 0
        )
        self.assertGreater(
            LoginBucket.objects.get(kind="ip", network_key=network_key("192.0.2.41")).count, 0
        )
        events = AuditEvent.objects.filter(type="login.limit_unlocked")
        self.assertEqual(events.count(), 2)
        for event in events:
            self.assertIsNone(event.actor)
            self.assertIsNone(event.resource_id)
            self.assertNotIn("192.0.2", json.dumps(event.metadata))
            self.assertNotIn("example.test", json.dumps(event.metadata))

    def test_new_window_and_success_only_consumes_ip(self):
        client = self.client_for(None, "192.0.2.50")
        self.post("/api/session/login", {"email": self.member.email, "password": "wrong"}, client)
        self.assertEqual(
            self.post(
                "/api/session/login", {"email": self.member.email, "password": PASSWORD}, client
            ).status_code,
            200,
        )
        self.assertEqual(LoginBucket.objects.get(kind="pair").count, 1)
        self.assertEqual(LoginBucket.objects.get(kind="identity").count, 1)
        self.assertEqual(LoginBucket.objects.get(kind="ip").count, 2)
        client.defaults["HTTP_X_CSRFTOKEN"] = client.get("/api/session/csrf").json()["csrf_token"]
        future = timezone.now() + timedelta(minutes=16)
        with patch("accounts.services.timezone.now", return_value=future):
            self.assertEqual(
                self.post(
                    "/api/session/login", {"email": self.member.email, "password": PASSWORD}, client
                ).status_code,
                200,
            )
        self.assertEqual(LoginBucket.objects.filter(kind="ip").count(), 2)
        for bucket in LoginBucket.objects.all():
            self.assertEqual(len(bucket.key), 64)
            self.assertNotIn("example", bucket.key)


class AuditAPI(APITransactionTest):
    def test_sanitization_pagination_filters_and_live_cursor(self):
        context = SimpleNamespace(
            request_id=str(__import__("uuid").uuid4()),
            network_key=network_key("192.0.2.80"),
            resolver_match=SimpleNamespace(url_name="rooms"),
        )
        base = timezone.now()
        metadata = {
            "reason_code": "AUTH_REQUIRED",
            "password": "secret",
            "nested": {"token": "secret"},
            "changed_fields": ["capacity", "password", "secret"],
        }
        emit(
            "operation.denied",
            context=context,
            aggregate=True,
            result="denied",
            metadata=metadata,
            now=base,
        )
        first = AuditEvent.objects.get()
        emit("room.created", actor=self.admin, resource="room", resource_id=self.room.pk)
        page1 = self.admin_client.get("/api/audit-events?page_size=1").json()
        self.assertTrue(page1["has_more"])
        emit(
            "operation.denied",
            context=context,
            aggregate=True,
            result="denied",
            metadata=metadata,
            now=base + timedelta(seconds=10),
        )
        emit(
            "operation.denied",
            context=context,
            aggregate=True,
            result="denied",
            metadata=metadata,
            now=base + timedelta(seconds=5),
        )
        page2 = self.admin_client.get(
            "/api/audit-events", {"page_size": 1, "cursor": page1["next_cursor"]}
        ).json()
        row = page2["results"][0]
        self.assertEqual(row["id"], first.id)
        self.assertEqual(row["count"], 3)
        self.assertEqual(row["last_at"], iso(base + timedelta(seconds=10)))
        self.assertNotIn("aggregation_key", row)
        self.assertNotIn("secret", json.dumps(row))
        filtered = self.admin_client.get(
            "/api/audit-events",
            {
                "from": iso(base + timedelta(seconds=6)),
                "to": iso(base + timedelta(seconds=9)),
                "result": "denied",
                "type": "operation.denied",
            },
        ).json()
        self.assertEqual(filtered["results"][0]["count"], 3)
        self.assertEqual(
            len(
                self.admin_client.get("/api/audit-events", {"actor_id": self.admin.id}).json()[
                    "results"
                ]
            ),
            1,
        )
        self.assert_error(self.client.get("/api/audit-events"), 403, "FORBIDDEN")
        for query in [
            "cursor=-1",
            "cursor=no",
            "type=secret",
            "result=bad",
            "actor_id=0",
            "from=bad",
            "page=1",
            "page_size=101",
        ]:
            self.assert_error(
                self.admin_client.get("/api/audit-events?" + query), 400, "VALIDATION_ERROR"
            )
        self.assertEqual(self.post("/api/audit-events", client=self.admin_client).status_code, 405)

    def test_audit_failure_on_denial_returns_service_unavailable(self):
        with patch("core.http.deny", side_effect=DatabaseError("sensitive")):
            response = self.other_client.get(f"/api/rooms/{self.room.id}/block")
            # Unsupported method is syntax; force a recognized authorization denial instead.
            response = self.post("/api/rooms", {"name": "X"}, self.other_client)
        self.assert_error(response, 503, "SERVICE_UNAVAILABLE")
        self.assertNotIn("sensitive", response.content.decode())
