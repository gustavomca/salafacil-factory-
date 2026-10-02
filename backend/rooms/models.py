from django.db import models

RESOURCES = ("projector", "whiteboard", "videoconference")


class Room(models.Model):
    name = models.CharField(max_length=120)
    description = models.CharField(max_length=2000, blank=True, default="")
    capacity = models.PositiveSmallIntegerField()
    location = models.CharField(max_length=200)
    resources = models.JSONField(default=list)
    status = models.CharField(max_length=10, default="active", db_index=True)
    blocked_reason = models.CharField(max_length=500, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(capacity__gte=1, capacity__lte=100), name="room_capacity"
            ),
            models.CheckConstraint(
                condition=models.Q(status__in=["active", "blocked", "inactive"]), name="room_status"
            ),
            models.CheckConstraint(
                condition=(models.Q(status="blocked") & ~models.Q(blocked_reason=""))
                | (models.Q(status__in=["active", "inactive"], blocked_reason="")),
                name="room_blocked_reason",
            ),
        ]
