from django.db.models import Exists, OuterRef
from django.utils import timezone

from core.errors import forbidden, invalid, not_found
from core.serializers import interval, query_date, query_int, query_interval
from reservations.models import Reservation
from rooms.models import Room


def reservation_list(actor, params):
    scope = params.get("scope", "mine")
    if scope not in {"mine", "all"}:
        raise invalid("scope", "Escopo inválido.")
    if scope == "all" and actor.role != "admin":
        raise forbidden()
    qs = Reservation.objects.select_related("room", "user")
    if scope == "mine":
        qs = qs.filter(user=actor)
    room_id = query_int(params.get("room_id"), "room_id", maximum=9223372036854775807)
    if room_id:
        qs = qs.filter(room_id=room_id)
    if "status" in params:
        if params["status"] not in {"confirmed", "cancelled"}:
            raise invalid("status", "Estado inválido.")
        qs = qs.filter(status=params["status"])
    start, end = query_interval(params)
    if start:
        qs = qs.filter(ends_at__gt=start)
    if end:
        qs = qs.filter(starts_at__lt=end)
    if "not_ended" in params:
        if params["not_ended"] not in {"true", "false"}:
            raise invalid("not_ended", "Use true ou false.")
        if params["not_ended"] == "true":
            qs = qs.filter(ends_at__gt=timezone.now())
        else:
            qs = qs.filter(ends_at__lte=timezone.now())
    ordering = ("starts_at", "id") if params.get("not_ended") == "true" else ("-starts_at", "-id")
    return qs.order_by(*ordering), scope


def reservation_detail(actor, reservation_id):
    try:
        reservation = Reservation.objects.select_related("room", "user").get(pk=reservation_id)
    except Reservation.DoesNotExist:
        raise not_found() from None
    if actor.role != "admin" and reservation.user_id != actor.id:
        raise forbidden("reservation", reservation.id)
    return reservation


def availability(params):
    start, end = (
        query_date(params.get("starts_at"), "starts_at"),
        query_date(params.get("ends_at"), "ends_at"),
    )
    if not start or not end:
        raise invalid("starts_at", "Informe início e fim.")
    interval(start, end, future=True)
    participants = query_int(params.get("participants"), "participants", maximum=100)
    occupied = Reservation.objects.filter(
        room_id=OuterRef("pk"), status="confirmed", starts_at__lt=end, ends_at__gt=start
    )
    qs = Room.objects.filter(status="active").filter(~Exists(occupied))
    if participants:
        qs = qs.filter(capacity__gte=participants)
    return qs.order_by("name", "id")
