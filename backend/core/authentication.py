from rest_framework.authentication import SessionAuthentication as DRFSessionAuthentication
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import BasePermission


class SessionAuthentication(DRFSessionAuthentication):
    def authenticate_header(self, request):
        return "Session"

    def enforce_csrf(self, request):
        try:
            super().enforce_csrf(request)
        except PermissionDenied:
            from core.errors import APIError

            raise APIError(
                "CSRF_FAILED", "Verificação de segurança inválida. Atualize a página.", 403
            ) from None


class Authenticated(BasePermission):
    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.is_active)


class Admin(Authenticated):
    def has_permission(self, request, view):
        return super().has_permission(request, view) and request.user.role == "admin"
