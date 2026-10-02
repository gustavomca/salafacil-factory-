from rest_framework.response import Response
from rest_framework.views import APIView

from audit.models import EVENT_TYPES, AuditEvent
from core.authentication import Admin
from core.errors import invalid
from core.serializers import iso, query_allowed, query_int, query_interval


class AuditEvents(APIView):
    permission_classes = [Admin]

    def get(self, request):
        query_allowed(request, {"type", "actor_id", "result", "from", "to", "cursor", "page_size"})
        params = request.query_params
        qs = AuditEvent.objects.select_related("actor").order_by("-id")
        if "type" in params:
            if params["type"] not in EVENT_TYPES:
                raise invalid("type", "Tipo inválido.")
            qs = qs.filter(type=params["type"])
        if "result" in params:
            if params["result"] not in {"success", "denied"}:
                raise invalid("result", "Resultado inválido.")
            qs = qs.filter(result=params["result"])
        actor_id = query_int(params.get("actor_id"), "actor_id", maximum=9223372036854775807)
        if actor_id:
            qs = qs.filter(actor_id=actor_id)
        start, end = query_interval(params)
        if start:
            qs = qs.filter(last_at__gte=start)
        if end:
            qs = qs.filter(first_at__lt=end)
        cursor = query_int(params.get("cursor"), "cursor", maximum=9223372036854775807)
        if cursor:
            qs = qs.filter(id__lt=cursor)
        size = query_int(params.get("page_size"), "page_size", default=20, maximum=100)
        rows = list(qs[: size + 1])
        more = len(rows) > size
        rows = rows[:size]
        return Response(
            {
                "results": [
                    {
                        "id": row.id,
                        "type": row.type,
                        "first_at": iso(row.first_at),
                        "last_at": iso(row.last_at),
                        "count": row.count,
                        "actor": {"id": row.actor_id, "name": row.actor.name}
                        if row.actor_id
                        else None,
                        "resource": row.resource,
                        "resource_id": row.resource_id,
                        "result": row.result,
                        "metadata": row.metadata,
                    }
                    for row in rows
                ],
                "next_cursor": str(rows[-1].id) if more else None,
                "has_more": more,
            }
        )
