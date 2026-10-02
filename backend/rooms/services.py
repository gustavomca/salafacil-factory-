from django.db import transaction
from django.utils import timezone

from audit.services import emit
from core.errors import APIError, forbidden, not_found
from reservations.models import Reservation
from rooms.models import Room


def require_admin(actor, room_id=None):
    if actor.role != "admin":
        raise forbidden("room", room_id)


def locked_room(room_id):
    try:
        return Room.objects.select_for_update().get(pk=room_id)
    except Room.DoesNotExist:
        raise not_found() from None


def create_room(actor, values, context=None):
    require_admin(actor)
    with transaction.atomic():
        room = Room.objects.create(**values)
        emit("room.created", actor=actor, resource="room", resource_id=room.id, context=context)
    return room


def update_room(actor, room_id, values, context=None):
    require_admin(actor, room_id)
    with transaction.atomic():
        room = locked_room(room_id)
        if (
            "capacity" in values
            and values["capacity"] < room.capacity
            and Reservation.objects.filter(
                room=room,
                status="confirmed",
                ends_at__gt=timezone.now(),
                participants__gt=values["capacity"],
            ).exists()
        ):
            raise APIError(
                "ROOM_CAPACITY_CONFLICT",
                "Resolva as reservas vigentes antes de reduzir a capacidade.",
                409,
                resource="room",
                resource_id=room.id,
            )
        changed = [field for field, value in values.items() if getattr(room, field) != value]
        if changed:
            for field, value in values.items():
                setattr(room, field, value)
            room.save(update_fields=[*changed, "updated_at"])
            emit(
                "room.updated",
                actor=actor,
                resource="room",
                resource_id=room.id,
                metadata={"changed_fields": changed},
                context=context,
            )
    return room


def transition_room(actor, room_id, action, reason="", context=None):
    require_admin(actor, room_id)
    with transaction.atomic():
        room = locked_room(room_id)
        before = room.status
        allowed = {
            "block": {"active", "blocked"},
            "unblock": {"blocked", "active"},
            "deactivate": {"active", "blocked", "inactive"},
            "reactivate": {"inactive", "active"},
        }
        if before not in allowed[action]:
            raise APIError(
                "INVALID_ROOM_STATE",
                "Esta transição não é permitida no estado atual.",
                409,
                resource="room",
                resource_id=room.id,
            )
        target = {
            "block": "blocked",
            "unblock": "active",
            "deactivate": "inactive",
            "reactivate": "active",
        }[action]
        blocked_reason = reason if target == "blocked" else ""
        affected = Reservation.objects.filter(
            room=room, status="confirmed", ends_at__gt=timezone.now()
        ).count()
        if target != before or room.blocked_reason != blocked_reason:
            changed = [
                field
                for field, value in (("status", target), ("blocked_reason", blocked_reason))
                if getattr(room, field) != value
            ]
            room.status, room.blocked_reason = target, blocked_reason
            room.save(update_fields=["status", "blocked_reason", "updated_at"])
            event = {
                "block": "blocked",
                "unblock": "unblocked",
                "deactivate": "deactivated",
                "reactivate": "reactivated",
            }[action]
            emit(
                f"room.{event}",
                actor=actor,
                resource="room",
                resource_id=room.id,
                metadata={
                    "previous_status": before,
                    "new_status": target,
                    "changed_fields": changed,
                },
                context=context,
            )
    return room, affected
