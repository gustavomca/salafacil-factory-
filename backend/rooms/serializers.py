from rest_framework import serializers

from core.serializers import StrictInteger, StrictSerializer, StrictText, iso
from rooms.models import RESOURCES


class RoomInput(StrictSerializer):
    name = StrictText(max_length=120)
    description = StrictText(max_length=2000, allow_blank=True, required=False, default="")
    capacity = StrictInteger(min_value=1, max_value=100)
    location = StrictText(max_length=200)
    resources = serializers.ListField(
        child=serializers.ChoiceField(
            choices=RESOURCES, error_messages={"invalid_choice": "Recurso inválido."}
        ),
        allow_empty=True,
        max_length=3,
        required=False,
        default=list,
    )

    def validate_resources(self, value):
        if len(value) != len(set(value)):
            raise serializers.ValidationError("Não repita recursos.")
        return sorted(value)


class BlockInput(StrictSerializer):
    reason = StrictText(max_length=500)


class EmptyInput(StrictSerializer):
    pass


def room_data(room):
    return {
        "id": room.id,
        "name": room.name,
        "description": room.description,
        "capacity": room.capacity,
        "location": room.location,
        "resources": room.resources,
        "status": room.status,
        "blocked_reason": room.blocked_reason,
        "created_at": iso(room.created_at),
        "updated_at": iso(room.updated_at),
    }
