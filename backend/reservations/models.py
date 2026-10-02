import uuid
from datetime import timedelta

from django.conf import settings
from django.contrib.postgres.constraints import ExclusionConstraint
from django.contrib.postgres.fields import DateTimeRangeField, RangeOperators
from django.db import models


class Reservation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    room = models.ForeignKey("rooms.Room", on_delete=models.PROTECT, related_name="reservations")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="reservations"
    )
    title = models.CharField(max_length=120)
    description = models.CharField(max_length=2000, blank=True, default="")
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField()
    participants = models.PositiveSmallIntegerField()
    status = models.CharField(max_length=10, default="confirmed")
    created_at = models.DateTimeField(auto_now_add=True)
    cancelled_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(participants__gte=1, participants__lte=100),
                name="reservation_participants",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    ends_at__gte=models.F("starts_at") + timedelta(minutes=15),
                    ends_at__lte=models.F("starts_at") + timedelta(hours=8),
                ),
                name="reservation_duration",
            ),
            models.CheckConstraint(
                condition=models.Q(status="confirmed", cancelled_at__isnull=True)
                | models.Q(status="cancelled", cancelled_at__isnull=False),
                name="reservation_status_cancelled",
            ),
            ExclusionConstraint(
                name="reservation_no_overlap",
                condition=models.Q(status="confirmed"),
                expressions=[
                    ("room", RangeOperators.EQUAL),
                    (
                        models.Func(
                            "starts_at",
                            "ends_at",
                            models.Value("[)"),
                            function="TSTZRANGE",
                            output_field=DateTimeRangeField(),
                        ),
                        RangeOperators.OVERLAPS,
                    ),
                ],
            ),
        ]
        indexes = [
            models.Index(fields=["user", "starts_at", "id"], name="reservation_user_start"),
            models.Index(fields=["room", "starts_at"], name="reservation_room_start"),
            models.Index(
                fields=["starts_at", "ends_at"],
                condition=models.Q(status="confirmed"),
                name="reservation_confirmed_time",
            ),
        ]
