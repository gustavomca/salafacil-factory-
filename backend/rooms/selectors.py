from core.errors import forbidden, invalid, not_found
from core.serializers import query_int
from rooms.models import RESOURCES, Room


def room_list(actor, params):
    qs = Room.objects.all()
    if actor.role != "admin":
        qs = qs.exclude(status="inactive")
    status = params.get("status")
    if status is not None:
        if status not in {"active", "blocked", "inactive"}:
            raise invalid("status", "Estado inválido.")
        if actor.role != "admin" and status == "inactive":
            raise forbidden()
        qs = qs.filter(status=status)
    if "search" in params:
        if len(params["search"]) > 200:
            raise invalid("search", "Use até 200 caracteres.")
        qs = qs.filter(name__icontains=params["search"].strip())
    capacity = query_int(params.get("capacity"), "capacity", maximum=100)
    if capacity:
        qs = qs.filter(capacity__gte=capacity)
    if "resources" in params:
        resources = params["resources"].split(",")
        if (
            not resources
            or len(resources) != len(set(resources))
            or set(resources) - set(RESOURCES)
        ):
            raise invalid("resources", "Recursos inválidos.")
        qs = qs.filter(resources__contains=resources)
    return qs.order_by("name", "id")


def room_detail(actor, room_id):
    try:
        room = Room.objects.get(pk=room_id)
    except Room.DoesNotExist:
        raise not_found() from None
    if actor.role != "admin" and room.status == "inactive":
        raise forbidden("room", room.id)
    return room
