from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.db.models import Exists, OuterRef
from django.http import JsonResponse
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.response import Response

from core.errors import invalid
from core.serializers import iso, query_allowed
from reservations.models import Reservation
from reservations.serializers import reservation_data
from rooms.models import Room


@api_view(["GET"])
def dashboard(request):
    query_allowed(request, {"date", "tz"})
    try:
        raw_date, tz = request.query_params["date"], request.query_params["tz"]
        day = date.fromisoformat(raw_date)
        if day.isoformat() != raw_date or len(tz) > 100:
            raise ValueError
        zone = ZoneInfo(tz)
        start = datetime.combine(day, time.min, tzinfo=zone)
        end = datetime.combine(day + timedelta(days=1), time.min, tzinfo=zone)
    except (KeyError, ValueError, ZoneInfoNotFoundError, OverflowError, OSError):
        raise invalid("date", "Informe date=YYYY-MM-DD e tz com um fuso IANA válido.") from None
    now = timezone.now()
    confirmed = Reservation.objects.filter(status="confirmed")
    mine = confirmed.filter(user=request.user).select_related("room")
    today = mine.filter(starts_at__lt=end, ends_at__gt=start).order_by("starts_at", "id")
    upcoming = mine.filter(starts_at__gte=now).order_by("starts_at", "id")
    occupied = confirmed.filter(room_id=OuterRef("pk"), starts_at__lte=now, ends_at__gt=now)
    counts = {
        "available_now": Room.objects.filter(status="active").filter(~Exists(occupied)).count(),
        "my_today": today.count(),
        "my_upcoming": upcoming.count(),
    }
    if request.user.role == "admin":
        counts.update(
            active_rooms=Room.objects.filter(status="active").count(),
            blocked_rooms=Room.objects.filter(status="blocked").count(),
            reservations_today=confirmed.filter(starts_at__lt=end, ends_at__gt=start).count(),
        )
    return Response(
        {
            "server_now": iso(now),
            "date": raw_date,
            "tz": tz,
            "upcoming": [reservation_data(x) for x in upcoming[:5]],
            "today": [reservation_data(x) for x in today[:5]],
            "counts": counts,
        }
    )


def live(request):
    return JsonResponse({"status": "ok"})


def ready(request):
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
        executor = MigrationExecutor(connection)
        if executor.migration_plan(executor.loader.graph.leaf_nodes()):
            return JsonResponse({"status": "unavailable"}, status=503)
    except Exception:
        return JsonResponse({"status": "unavailable"}, status=503)
    return JsonResponse({"status": "ok"})
