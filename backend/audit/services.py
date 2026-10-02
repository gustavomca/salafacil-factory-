import contextlib
import json
import re
import uuid

from django.db import connection
from django.utils import timezone

from audit.models import EVENT_TYPES, RESOURCES, AuditEvent
from core.identity import protected_key, window_start

REASONS = {
    "AUTH_REQUIRED",
    "INVALID_CREDENTIALS",
    "FORBIDDEN",
    "CSRF_FAILED",
    "LOGIN_RATE_LIMITED",
    "ROOM_UNAVAILABLE",
    "ROOM_CAPACITY_CONFLICT",
    "INVALID_ROOM_STATE",
    "VALIDATION_ERROR",
    "INITIAL_SETUP",
    "OWNER_REQUEST",
    "SECURITY_RESPONSE",
    "SUPPORT_RECOVERY",
}
CHANGED_FIELDS = {
    "name",
    "description",
    "capacity",
    "location",
    "resources",
    "status",
    "blocked_reason",
}

METADATA_FIELDS = {
    "login.denied": {"request_id", "reason_code"},
    "login.limit_unlocked": {"reason_code", "target_kind"},
    "account.provisioned": {"reason_code"},
    "room.updated": {"request_id", "changed_fields"},
    **{
        f"room.{action}": {"request_id", "changed_fields", "previous_status", "new_status"}
        for action in ("blocked", "unblocked", "deactivated", "reactivated")
    },
    "operation.denied": {"request_id", "reason_code"},
}


def clean_metadata(metadata):
    clean = {}
    metadata = metadata or {}
    request_id = metadata.get("request_id")
    if isinstance(request_id, str):
        with contextlib.suppress(ValueError):
            clean["request_id"] = str(uuid.UUID(request_id))
    if isinstance(metadata.get("reason_code"), str) and metadata["reason_code"] in REASONS:
        clean["reason_code"] = metadata["reason_code"]
    changed = metadata.get("changed_fields")
    if isinstance(changed, list):
        clean["changed_fields"] = sorted(
            {x for x in changed if isinstance(x, str) and x in CHANGED_FIELDS}
        )
    for key in ("previous_status", "new_status"):
        if isinstance(metadata.get(key), str) and metadata[key] in {
            "active",
            "blocked",
            "inactive",
        }:
            clean[key] = metadata[key]
    if isinstance(metadata.get("target_kind"), str) and metadata["target_kind"] in {
        "identity",
        "network",
    }:
        clean["target_kind"] = metadata["target_kind"]
    return clean


def safe_resource_id(value):
    if value is None:
        return None
    value = str(value)
    if re.fullmatch(r"[1-9][0-9]{0,18}", value):
        return value
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return None


def emit(
    event_type,
    *,
    actor=None,
    resource="http",
    resource_id=None,
    result="success",
    metadata=None,
    context=None,
    aggregate=False,
    now=None,
):
    if (
        event_type not in EVENT_TYPES
        or resource not in RESOURCES
        or result not in {"success", "denied"}
    ):
        raise ValueError("Unrecognized audit event")
    now = now or timezone.now()
    actor_id = actor.pk if actor is not None and actor.is_authenticated else None
    metadata = clean_metadata(
        {**(metadata or {}), **({"request_id": context.request_id} if context is not None else {})}
    )
    metadata = {
        key: value
        for key, value in metadata.items()
        if key in METADATA_FIELDS.get(event_type, {"request_id"})
    }
    resource_id = safe_resource_id(resource_id)
    if not aggregate:
        return AuditEvent.objects.create(
            type=event_type,
            first_at=now,
            last_at=now,
            actor_id=actor_id,
            resource=resource,
            resource_id=resource_id,
            result=result,
            metadata=metadata,
        )
    if context is None or not getattr(context, "network_key", None):
        raise ValueError("Aggregation requires validated network context")
    route = getattr(getattr(context, "resolver_match", None), "url_name", None) or "unmatched"
    group = json.dumps(
        [
            window_start(now).isoformat(),
            event_type,
            metadata.get("reason_code"),
            route,
            actor_id if actor_id is not None else "unknown",
            context.network_key,
        ],
        separators=(",", ":"),
    )
    key = protected_key("audit-group", group)
    with connection.cursor() as cursor:
        cursor.execute(
            """INSERT INTO audit_auditevent
            (type, first_at, last_at, count, actor_id, resource, resource_id, result, metadata, aggregation_key)
            VALUES (%s, %s, %s, 1, %s, %s, %s, %s, %s::jsonb, %s)
            ON CONFLICT (aggregation_key) DO UPDATE
            SET count = audit_auditevent.count + 1,
                last_at = GREATEST(audit_auditevent.last_at, EXCLUDED.last_at)""",
            [
                event_type,
                now,
                now,
                actor_id,
                resource,
                resource_id,
                result,
                json.dumps(metadata),
                key,
            ],
        )


def deny(context, error):
    actor = getattr(context, "user", None)
    anonymous = not actor or not actor.is_authenticated
    emit(
        "operation.denied",
        actor=actor,
        resource="http" if anonymous else error.resource,
        resource_id=None if anonymous else error.resource_id,
        result="denied",
        metadata={"reason_code": error.code},
        context=context,
        aggregate=anonymous and (error.status == 401 or error.code == "CSRF_FAILED"),
    )
