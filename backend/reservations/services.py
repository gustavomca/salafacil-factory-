from django.db import IntegrityError, transaction
from django.utils import timezone

from audit.services import emit
from core.errors import APIError, forbidden, invalid, not_found
from reservations.models import Reservation
from rooms.services import locked_room


def create_reservation(actor, values, context=None):
    room_id = values["room_id"]
    try:
        with transaction.atomic():
            room = locked_room(room_id)
            if room.status == "inactive" and actor.role != "admin":
                raise forbidden("room", room.id)
            if values["starts_at"] < timezone.now():
                raise invalid("starts_at", "O início já passou. Escolha um horário futuro.")
            if room.status != "active":
                raise APIError(
                    "ROOM_UNAVAILABLE",
                    "A sala não está disponível.",
                    409,
                    resource="room",
                    resource_id=room.id,
                )
            if values["participants"] > room.capacity:
                raise APIError(
                    "ROOM_CAPACITY_CONFLICT",
                    "A quantidade de participantes supera a capacidade atual.",
                    409,
                    resource="room",
                    resource_id=room.id,
                )
            if Reservation.objects.filter(
                room=room,
                status="confirmed",
                starts_at__lt=values["ends_at"],
                ends_at__gt=values["starts_at"],
            ).exists():
                raise APIError(
                    "ROOM_UNAVAILABLE",
                    "A sala já está reservada neste intervalo.",
                    409,
                    resource="room",
                    resource_id=room.id,
                )
            reservation = Reservation.objects.create(
                user=actor, room=room, **{k: v for k, v in values.items() if k != "room_id"}
            )
            emit(
                "reservation.created",
                actor=actor,
                resource="reservation",
                resource_id=reservation.id,
                context=context,
            )
        return reservation
    except IntegrityError as exc:
        if (
            getattr(getattr(exc.__cause__, "diag", None), "constraint_name", None)
            == "reservation_no_overlap"
        ):
            raise APIError(
                "ROOM_UNAVAILABLE",
                "A sala já está reservada neste intervalo.",
                409,
                resource="room",
                resource_id=room_id,
            ) from None
        raise


def cancel_reservation(actor, reservation_id, context=None):
    room_id = (
        Reservation.objects.filter(pk=reservation_id).values_list("room_id", flat=True).first()
    )
    if room_id is None:
        raise not_found()
    with transaction.atomic():
        room = locked_room(room_id)
        reservation = Reservation.objects.select_for_update().get(pk=reservation_id)
        if reservation.user_id != actor.id and actor.role != "admin":
            raise forbidden("reservation", reservation.id)
        if reservation.status != "cancelled":
            reservation.status = "cancelled"
            reservation.cancelled_at = timezone.now()
            reservation.save(update_fields=["status", "cancelled_at"])
            emit(
                "reservation.cancelled",
                actor=actor,
                resource="reservation",
                resource_id=reservation.id,
                context=context,
            )
        reservation.room = room
    return reservation
