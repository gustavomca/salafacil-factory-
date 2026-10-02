"""Explicit environment configuration; PostgreSQL is required in every environment."""

import os
from urllib.parse import urlparse

from django.core.exceptions import ImproperlyConfigured
from psycopg import IsolationLevel

APP_ENV = os.environ.get("APP_ENV", "local")
if APP_ENV not in {"local", "test", "production"}:
    raise ImproperlyConfigured("APP_ENV must be local, test or production.")
PRODUCTION = APP_ENV == "production"


def boolean(name, default=False):
    value = os.environ.get(name, str(default)).lower()
    if value not in {"true", "false", "1", "0"}:
        raise ImproperlyConfigured(f"{name} must be true or false.")
    return value in {"true", "1"}


def comma_list(name, default=""):
    return [v.strip() for v in os.environ.get(name, default).split(",") if v.strip()]


DEBUG = boolean("DEBUG")
SECRET_KEY = os.environ.get("SECRET_KEY", "salafacil-local-development-only-not-for-production")
ALLOWED_HOSTS = comma_list(
    "ALLOWED_HOSTS", "localhost,127.0.0.1,[::1],testserver" if not PRODUCTION else ""
)
CSRF_TRUSTED_ORIGINS = comma_list("CSRF_TRUSTED_ORIGINS")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "salafacil-local-password" if not PRODUCTION else "")
if PRODUCTION:
    forbidden = (
        "local",
        "example",
        "placeholder",
        "changeme",
        "change-me",
        "development",
        "your-secret",
    )
    if (
        DEBUG
        or len(SECRET_KEY) < 50
        or len(set(SECRET_KEY)) < 10
        or any(v in SECRET_KEY.lower() for v in forbidden)
    ):
        raise ImproperlyConfigured(
            "Production requires DEBUG=false and a strong independent SECRET_KEY."
        )
    if not ALLOWED_HOSTS or any("*" in h or h.startswith(".") for h in ALLOWED_HOSTS):
        raise ImproperlyConfigured("Production requires explicit ALLOWED_HOSTS.")
    if not CSRF_TRUSTED_ORIGINS:
        raise ImproperlyConfigured("Production requires explicit HTTPS CSRF_TRUSTED_ORIGINS.")
    for origin in CSRF_TRUSTED_ORIGINS:
        parsed = urlparse(origin)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or "*" in origin
            or parsed.username
            or parsed.password
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ImproperlyConfigured("Production CSRF origins must be explicit HTTPS origins.")
    if (
        len(DB_PASSWORD) < 20
        or len(set(DB_PASSWORD)) < 8
        or any(v in DB_PASSWORD.lower() for v in forbidden)
    ):
        raise ImproperlyConfigured("Production requires an independent database password.")
    if not all(os.environ.get(k) for k in ("DB_NAME", "DB_USER", "DB_HOST")):
        raise ImproperlyConfigured("Production requires explicit database configuration.")

INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.postgres",
    "rest_framework",
    "accounts",
    "rooms",
    "reservations",
    "audit",
]
MIDDLEWARE = [
    "core.middleware.RequestContextMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("DB_NAME", "salafacil"),
        "USER": os.environ.get("DB_USER", "salafacil"),
        "PASSWORD": DB_PASSWORD,
        "HOST": os.environ.get("DB_HOST", "127.0.0.1"),
        "PORT": os.environ.get("DB_PORT", "5432"),
        "ATOMIC_REQUESTS": False,
        "CONN_MAX_AGE": 60,
        "OPTIONS": {
            "options": "-c lock_timeout=5000",
            "isolation_level": IsolationLevel.READ_COMMITTED,
        },
        "TEST": {"NAME": os.environ.get("DB_TEST_NAME") or None},
    }
}
AUTH_USER_MODEL = "accounts.User"
AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 12},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
]
PASSWORD_HASHERS = ["django.contrib.auth.hashers.PBKDF2PasswordHasher"]
LANGUAGE_CODE = "pt-br"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
APPEND_SLASH = False
SESSION_ENGINE = "django.contrib.sessions.backends.db"
SESSION_COOKIE_NAME = "salafacil_session"
SESSION_COOKIE_AGE = 8 * 3600
SESSION_SAVE_EVERY_REQUEST = False
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SECURE = PRODUCTION
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_PATH = "/"
SESSION_COOKIE_DOMAIN = None
CSRF_COOKIE_HTTPONLY = True
CSRF_COOKIE_SECURE = PRODUCTION
CSRF_COOKIE_SAMESITE = "Lax"
CSRF_USE_SESSIONS = False
CSRF_FAILURE_VIEW = "core.http.csrf_failure"
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = PRODUCTION
SECURE_REDIRECT_EXEMPT = [r"^health/(live|ready)$"]
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_HSTS_SECONDS = 31536000 if PRODUCTION else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = PRODUCTION
SECURE_HSTS_PRELOAD = False
X_FRAME_OPTIONS = "DENY"
DATA_UPLOAD_MAX_MEMORY_SIZE = 32768
FILE_UPLOAD_MAX_MEMORY_SIZE = 0
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["core.authentication.SessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["core.authentication.Authenticated"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "EXCEPTION_HANDLER": "core.http.exception_handler",
    "UNAUTHENTICATED_USER": "django.contrib.auth.models.AnonymousUser",
}
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"safe": {"()": "core.logging.SafeJSONFormatter"}},
    "filters": {"deduplicate_request": {"()": "core.logging.RequestLogDeduplication"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "safe"}},
    "root": {"handlers": ["console"], "level": "INFO"},
    "loggers": {
        "django": {"handlers": ["console"], "level": "WARNING", "propagate": False},
        "django.request": {
            "handlers": ["console"],
            "filters": ["deduplicate_request"],
            "level": "WARNING",
            "propagate": False,
        },
        "django.security.csrf": {
            "handlers": ["console"],
            "filters": ["deduplicate_request"],
            "level": "WARNING",
            "propagate": False,
        },
    },
}

TEST_RUNNER = "core.test_runner.NonEmptyDiscoverRunner"
