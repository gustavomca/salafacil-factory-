import json

from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.middleware.csrf import get_token
from django.utils import timezone
from django.views.decorators.csrf import csrf_protect
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from accounts.serializers import LoginInput, user_data
from accounts.services import end_session, start_session
from core.errors import APIError
from core.http import envelope, handle_error
from core.serializers import iso, query_allowed


@api_view(["GET"])
@permission_classes([AllowAny])
def csrf_token(request):
    query_allowed(request, set())
    return Response({"csrf_token": get_token(request), "server_now": iso(timezone.now())})


@api_view(["GET"])
@permission_classes([AllowAny])
def me(request):
    query_allowed(request, set())
    return Response({"user": user_data(request.user) if request.user.is_authenticated else None})


@csrf_protect
def login_view(request):
    try:
        if request.method != "POST":
            raise APIError("METHOD_NOT_ALLOWED", "Método não permitido.", 405, audit=False)
        if request.GET:
            raise APIError("VALIDATION_ERROR", "Parâmetros não permitidos.", audit=False)
        if request.content_type != "application/json":
            raise APIError("VALIDATION_ERROR", "Envie um objeto JSON válido.", audit=False)
        try:
            data = json.loads(request.body)
        except (ValueError, UnicodeDecodeError):
            raise APIError(
                "VALIDATION_ERROR", "Envie um objeto JSON válido.", audit=False
            ) from None
        serializer = LoginInput(data=data)
        serializer.is_valid(raise_exception=True)
        result = start_session(request, **serializer.validated_data)
        if isinstance(result, APIError):
            raise result
        response = JsonResponse({"user": user_data(result)})
        response.set_cookie(
            settings.SESSION_COOKIE_NAME,
            request.session.session_key,
            max_age=request.session.get_expiry_age(),
            httponly=True,
            secure=settings.SESSION_COOKIE_SECURE,
            samesite=settings.SESSION_COOKIE_SAMESITE,
            path="/",
        )
        return response
    except Exception as exc:
        error = handle_error(exc, request)
        return JsonResponse(envelope(error), status=error.status, headers=error.headers)


@api_view(["POST"])
def logout_view(request):
    query_allowed(request, set())
    if request.data:
        raise APIError("VALIDATION_ERROR", "O corpo deve estar vazio.", audit=False)
    end_session(request)
    return HttpResponse(status=204)
