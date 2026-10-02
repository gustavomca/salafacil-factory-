from rest_framework.response import Response
from rest_framework.views import APIView

from core.serializers import paginate, query_allowed
from rooms import selectors, services
from rooms.serializers import BlockInput, EmptyInput, RoomInput, room_data


class Rooms(APIView):
    def get(self, request):
        query_allowed(request, {"search", "capacity", "resources", "status", "page", "page_size"})
        return Response(
            paginate(request, selectors.room_list(request.user, request.query_params), room_data)
        )

    def post(self, request):
        services.require_admin(request.user)
        query_allowed(request, set())
        payload = RoomInput(data=request.data)
        payload.is_valid(raise_exception=True)
        return Response(
            room_data(services.create_room(request.user, payload.validated_data, request)),
            status=201,
        )


class RoomDetail(APIView):
    def get(self, request, room_id):
        query_allowed(request, set())
        return Response(room_data(selectors.room_detail(request.user, room_id)))

    def patch(self, request, room_id):
        services.require_admin(request.user, room_id)
        query_allowed(request, set())
        payload = RoomInput(data=request.data, partial=True)
        payload.is_valid(raise_exception=True)
        return Response(
            room_data(services.update_room(request.user, room_id, payload.validated_data, request))
        )


class RoomTransition(APIView):
    action = None

    def post(self, request, room_id):
        services.require_admin(request.user, room_id)
        query_allowed(request, set())
        payload = (BlockInput if self.action == "block" else EmptyInput)(data=request.data)
        payload.is_valid(raise_exception=True)
        room, count = services.transition_room(
            request.user, room_id, self.action, payload.validated_data.get("reason", ""), request
        )
        return Response({**room_data(room), "affected_reservations_count": count})
