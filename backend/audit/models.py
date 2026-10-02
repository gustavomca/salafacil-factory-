from django.conf import settings
from django.db import models

EVENT_TYPES = (
    "login.success",
    "login.denied",
    "logout",
    "login.limit_unlocked",
    "account.provisioned",
    "room.created",
    "room.updated",
    "room.blocked",
    "room.unblocked",
    "room.deactivated",
    "room.reactivated",
    "reservation.created",
    "reservation.cancelled",
    "operation.denied",
)
RESOURCES = ("session", "http", "room", "reservation", "user", "login_limit")


class AuditEvent(models.Model):
    type = models.CharField(max_length=40)
    first_at = models.DateTimeField(db_index=True)
    last_at = models.DateTimeField(db_index=True)
    count = models.PositiveBigIntegerField(default=1)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT)
    resource = models.CharField(max_length=20)
    resource_id = models.CharField(max_length=64, null=True)
    result = models.CharField(max_length=10)
    metadata = models.JSONField(default=dict)
    aggregation_key = models.CharField(max_length=64, unique=True, null=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(first_at__lte=models.F("last_at")), name="audit_time_order"
            ),
            models.CheckConstraint(condition=models.Q(count__gte=1), name="audit_count_positive"),
            models.CheckConstraint(
                condition=models.Q(result__in=["success", "denied"]), name="audit_result"
            ),
            models.CheckConstraint(condition=models.Q(type__in=EVENT_TYPES), name="audit_type"),
            models.CheckConstraint(
                condition=models.Q(resource__in=RESOURCES), name="audit_resource"
            ),
        ]
        indexes = [
            models.Index(fields=["type", "id"], name="audit_type_id"),
            models.Index(fields=["actor", "id"], name="audit_actor_id"),
            models.Index(fields=["result", "id"], name="audit_result_id"),
        ]
