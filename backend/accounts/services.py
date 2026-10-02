from datetime import timedelta

from django.contrib.auth import login, logout
from django.contrib.auth.hashers import make_password
from django.contrib.sessions.backends.db import SessionStore
from django.db import connection, transaction
from django.utils import timezone

from accounts.models import LoginBucket, User
from audit.services import emit
from core.errors import APIError
from core.identity import protected_key, window_start

LIMITS = {"ip": 60, "pair": 10, "identity": 100}


def lock_bucket(kind, key, identity_key, network_key, start):
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO accounts_loginbucket (kind, key, identity_key, network_key, window_start, count) VALUES (%s, %s, %s, %s, %s, 0) ON CONFLICT (kind, key, window_start) DO NOTHING",
            [kind, key, identity_key, network_key, start],
        )
    return LoginBucket.objects.select_for_update().get(kind=kind, key=key, window_start=start)


def locked_buckets(email, network, now):
    """All writers lock IP → identity → pair; blocked IPs never create identity state."""
    start = window_start(now)
    buckets = {"ip": lock_bucket("ip", network, None, network, start)}
    if buckets["ip"].count >= LIMITS["ip"]:
        return buckets
    identity = protected_key("identity", email)
    pair = protected_key("pair", f"{identity}:{network}")
    buckets["identity"] = lock_bucket("identity", identity, identity, None, start)
    buckets["pair"] = lock_bucket("pair", pair, identity, network, start)
    return buckets


def start_session(request, email, password):
    original_key = request.session.session_key
    original_csrf = request.META.get("CSRF_COOKIE")
    original_csrf_update = request.META.get("CSRF_COOKIE_NEEDS_UPDATE", False)
    try:
        with transaction.atomic():
            now = timezone.now()
            buckets = locked_buckets(email, request.network_key, now)
            limited = buckets["ip"].count >= LIMITS["ip"]
            if not limited:
                buckets["ip"].count += 1
                buckets["ip"].save(update_fields=["count"])
                limited = any(buckets[k].count >= LIMITS[k] for k in ("pair", "identity"))
            if limited:
                emit(
                    "login.denied",
                    resource="session",
                    result="denied",
                    metadata={"reason_code": "LOGIN_RATE_LIMITED"},
                    context=request,
                    aggregate=True,
                    now=now,
                )
                retry = max(
                    1, int((window_start(now) + timedelta(minutes=15) - now).total_seconds()) + 1
                )
                return APIError(
                    "LOGIN_RATE_LIMITED",
                    "Muitas tentativas. Aguarde antes de tentar novamente.",
                    429,
                    audit=False,
                    headers={"Retry-After": str(retry)},
                )
            user = User.objects.filter(email=email).first()
            valid = (
                user.check_password(password) if user else bool(make_password(password)) and False
            )
            if not valid or not user.is_active:
                for kind in ("pair", "identity"):
                    buckets[kind].count += 1
                    buckets[kind].save(update_fields=["count"])
                emit(
                    "login.denied",
                    actor=user,
                    resource="session",
                    result="denied",
                    metadata={"reason_code": "INVALID_CREDENTIALS"},
                    context=request,
                    aggregate=True,
                    now=now,
                )
                return APIError(
                    "INVALID_CREDENTIALS",
                    "E-mail ou senha inválidos.",
                    401,
                    audit=False,
                    headers={"WWW-Authenticate": "Session"},
                )
            login(request, user, backend="django.contrib.auth.backends.ModelBackend")
            if request.session.session_key == original_key:
                request.session.cycle_key()
            request.session.set_expiry(timezone.now() + timedelta(hours=8))
            request.session.save()
            request.session.modified = False
            emit("login.success", actor=user, resource="session", context=request)
        return user
    except Exception:
        # Middleware must never recreate a session whose audit/transaction failed.
        request.session = SessionStore(session_key=original_key)
        if original_csrf is not None:
            request.META["CSRF_COOKIE"] = original_csrf
        else:
            request.META.pop("CSRF_COOKIE", None)
        request.META["CSRF_COOKIE_NEEDS_UPDATE"] = original_csrf_update
        raise


def end_session(request):
    request = getattr(request, "_request", request)
    original_key = request.session.session_key
    actor = request.user
    try:
        with transaction.atomic():
            logout(request)
            emit("logout", actor=actor, resource="session", context=request)
    except Exception:
        request.session = SessionStore(session_key=original_key)
        raise
