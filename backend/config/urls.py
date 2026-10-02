from django.urls import path, re_path

from accounts import views as accounts
from audit.views import AuditEvents
from core import views
from core.http import error404
from reservations.views import Availability, ReservationCancel, ReservationDetail, Reservations
from rooms.views import RoomDetail, Rooms, RoomTransition

handler400 = "core.http.error400"
handler404 = "core.http.error404"
handler500 = "core.http.error500"
urlpatterns = [
    path("health/live", views.live, name="health-live"),
    path("health/ready", views.ready, name="health-ready"),
    path("api/session/csrf", accounts.csrf_token, name="session-csrf"),
    path("api/session/login", accounts.login_view, name="session-login"),
    path("api/session/logout", accounts.logout_view, name="session-logout"),
    path("api/session/me", accounts.me, name="session-me"),
    path("api/rooms", Rooms.as_view(), name="rooms"),
    path("api/rooms/<int:room_id>", RoomDetail.as_view(), name="room-detail"),
    *[
        path(
            f"api/rooms/<int:room_id>/{action}",
            RoomTransition.as_view(action=action),
            name=f"room-{action}",
        )
        for action in ("block", "unblock", "deactivate", "reactivate")
    ],
    path("api/availability", Availability.as_view(), name="availability"),
    path("api/reservations", Reservations.as_view(), name="reservations"),
    path(
        "api/reservations/<uuid:reservation_id>",
        ReservationDetail.as_view(),
        name="reservation-detail",
    ),
    path(
        "api/reservations/<uuid:reservation_id>/cancel",
        ReservationCancel.as_view(),
        name="reservation-cancel",
    ),
    path("api/dashboard", views.dashboard, name="dashboard"),
    path("api/audit-events", AuditEvents.as_view(), name="audit-events"),
    re_path(r"^.*$", error404, name="not-found"),
]
