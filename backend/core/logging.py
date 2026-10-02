import hashlib
import json
import logging
import re
from datetime import UTC, datetime


def symbol(value):
    """Identifiers come from loaded Python code, never from exception messages/locals."""
    return (
        value
        if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.<>]{1,180}", value)
        else "unknown"
    )


def exception_diagnostics(exc):
    frames = []
    tb = exc.__traceback__
    while tb is not None:
        frame = tb.tb_frame
        frames.append(
            {
                "module": symbol(frame.f_globals.get("__name__")),
                "function": symbol(frame.f_code.co_name),
                "line": tb.tb_lineno,
            }
        )
        tb = tb.tb_next
    origin = frames[-1] if frames else {"module": "unknown", "function": "unknown", "line": 0}
    kind = {"module": symbol(type(exc).__module__), "class": symbol(type(exc).__qualname__)}
    fingerprint = json.dumps(
        {"exception": kind, "frames": frames}, sort_keys=True, separators=(",", ":")
    )
    return {
        "exception_class": kind["class"],
        "exception_module": kind["module"],
        "origin_module": origin["module"],
        "origin_function": origin["function"],
        "origin_line": origin["line"],
        "stack_hash": hashlib.sha256(fingerprint.encode()).hexdigest(),
    }


class RequestLogDeduplication(logging.Filter):
    """HTTP outcomes already have a structured access record; keep real exceptions."""

    def filter(self, record):
        return bool(record.exc_info) or not getattr(
            getattr(record, "request", None), "request_id", None
        )


class SafeJSONFormatter(logging.Formatter):
    """Structural diagnostics only: no messages, SQL, arguments, source lines or locals."""

    def format(self, record):
        payload = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "event": getattr(record, "safe_event", "framework_error"),
        }
        for key in (
            "request_id",
            "method",
            "route",
            "status",
            "duration_ms",
            "error_code",
            "exception_class",
            "exception_module",
            "origin_module",
            "origin_function",
            "origin_line",
            "stack_hash",
        ):
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        if record.exc_info and isinstance(record.exc_info[1], BaseException):
            payload.update(exception_diagnostics(record.exc_info[1]))
            request = getattr(record, "request", None)
            if request is not None:
                payload["request_id"] = getattr(request, "request_id", None)
        return json.dumps(payload, ensure_ascii=False)
