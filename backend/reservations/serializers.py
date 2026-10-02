from core.serializers import (
    OffsetDateTime,
    StrictInteger,
    StrictSerializer,
    StrictText,
    interval,
    iso,
)


class ReservationInput(StrictSerializer):
    room_id = StrictInteger(min_value=1, max_value=9223372036854775807)
    title = StrictText(max_length=120)
    description = StrictText(max_length=2000, allow_blank=True, required=False, default="")
    starts_at = OffsetDateTime()
    ends_at = OffsetDateTime()
    participants = StrictInteger(min_value=1, max_value=100)

    def validate(self, values):
        interval(values["starts_at"], values["ends_at"])
        return values


def reservation_data(reservation, include_user=False):
    room = reservation.room
    data = {
        "id": str(reservation.id),
        "room": {
            "id": room.id,
            "name": room.name,
            "status": room.status,
            "capacity": room.capacity,
            "location": room.location,
            "blocked_reason": room.blocked_reason,
        },
        "title": reservation.title,
        "description": reservation.description,
        "starts_at": iso(reservation.starts_at),
        "ends_at": iso(reservation.ends_at),
        "participants": reservation.participants,
        "status": reservation.status,
        "created_at": iso(reservation.created_at),
        "cancelled_at": iso(reservation.cancelled_at),
    }
    if include_user:
        data["user"] = {
            "id": reservation.user_id,
            "name": reservation.user.name,
            "email": reservation.user.email,
        }
    return data
