from rest_framework.response import Response
from rest_framework.views import APIView

from core.errors import forbidden, invalid
from core.serializers import paginate, query_allowed
from reservations import selectors, services
from reservations.serializers import ReservationInput, reservation_data
from rooms.serializers import EmptyInput, room_data


class Reservations(APIView):
    def get(self, request):
        query_allowed(
            request, {"scope", "room_id", "status", "from", "to", "not_ended", "page", "page_size"}
        )
        qs, scope = selectors.reservation_list(request.user, request.query_params)
        return Response(
            paginate(request, qs, lambda x: reservation_data(x, include_user=scope == "all"))
        )

    def post(self, request):
        query_allowed(request, set())
        payload = ReservationInput(data=request.data)
        payload.is_valid(raise_exception=True)
        return Response(
            reservation_data(
                services.create_reservation(request.user, payload.validated_data, request)
            ),
            status=201,
        )


class ReservationDetail(APIView):
    def get(self, request, reservation_id):
        query_allowed(request, {"scope"})
        scope = request.query_params.get("scope", "mine")
        if scope not in {"mine", "all"}:
            raise invalid("scope", "Escopo inválido.")
        if scope == "all" and request.user.role != "admin":
            raise forbidden("reservation", reservation_id)
        return Response(
            reservation_data(
                selectors.reservation_detail(request.user, reservation_id),
                include_user=scope == "all",
            )
        )


class ReservationCancel(APIView):
    def post(self, request, reservation_id):
        query_allowed(request, set())
        payload = EmptyInput(data=request.data)
        payload.is_valid(raise_exception=True)
        return Response(
            reservation_data(services.cancel_reservation(request.user, reservation_id, request))
        )


class Availability(APIView):
    def get(self, request):
        query_allowed(request, {"starts_at", "ends_at", "participants", "page", "page_size"})
        return Response(paginate(request, selectors.availability(request.query_params), room_data))
