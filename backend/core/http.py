import logging

from django.db import DatabaseError, OperationalError, transaction
from django.http import JsonResponse
from rest_framework import exceptions
from rest_framework.response import Response

from audit.services import deny
from core.errors import APIError
from core.logging import exception_diagnostics

logger = logging.getLogger("salafacil")


def envelope(error):
    return {"error": {"code": error.code, "message": error.message, "details": error.details}}


def database_error(exc):
    cause = getattr(exc, "__cause__", None)
    if getattr(cause, "sqlstate", None) in {"55P03", "40P01"}:
        return APIError(
            "RETRY_LATER",
            "Operação ocupada. Consulte o resultado antes de tentar novamente.",
            503,
            audit=False,
        )
    return APIError(
        "SERVICE_UNAVAILABLE", "Serviço temporariamente indisponível.", 503, audit=False
    )


def normalize(exc):
    if isinstance(exc, APIError):
        return exc
    if isinstance(exc, exceptions.ValidationError):
        details = exc.detail if isinstance(exc.detail, dict) else {"body": exc.detail}
        return APIError(
            "VALIDATION_ERROR", "Confira os campos informados.", details=details, audit=False
        )
    if isinstance(exc, (exceptions.ParseError, exceptions.UnsupportedMediaType)):
        return APIError("VALIDATION_ERROR", "Envie um objeto JSON válido.", audit=False)
    if isinstance(exc, exceptions.NotAuthenticated):
        return APIError(
            "AUTH_REQUIRED", "Entre para continuar.", 401, headers={"WWW-Authenticate": "Session"}
        )
    if isinstance(exc, exceptions.PermissionDenied):
        return APIError("FORBIDDEN", "Você não tem permissão para esta operação.", 403)
    if isinstance(exc, (exceptions.NotFound,)):
        return APIError("NOT_FOUND", "Recurso não encontrado.", 404, audit=False)
    if isinstance(exc, exceptions.MethodNotAllowed):
        return APIError("METHOD_NOT_ALLOWED", "Método não permitido.", 405, audit=False)
    if isinstance(exc, (DatabaseError, OperationalError)):
        return database_error(exc)
    return APIError("INTERNAL_ERROR", "Não foi possível concluir a operação.", 500, audit=False)


def handle_error(exc, request):
    request = getattr(request, "_request", request)
    error = normalize(exc)
    diagnostic_exception = exc
    if error.audit:
        try:
            with transaction.atomic():
                deny(request, error)
        except DatabaseError as failure:
            error = database_error(failure)
            diagnostic_exception = failure
    request.error_code = error.code
    if error.status >= 500:
        logger.error(
            "request failure",
            extra={
                "safe_event": "request_failure",
                "request_id": getattr(request, "request_id", None),
                "error_code": error.code,
                **exception_diagnostics(diagnostic_exception),
            },
        )
    return error


def exception_handler(exc, context):
    request = context["request"]
    error = handle_error(exc, request)
    return Response(envelope(error), status=error.status, headers=error.headers)


def csrf_failure(request, reason=""):
    error = handle_error(
        APIError("CSRF_FAILED", "Verificação de segurança inválida. Atualize a página.", 403),
        request,
    )
    return JsonResponse(envelope(error), status=error.status)


def error404(request, exception=None):
    return JsonResponse(
        envelope(APIError("NOT_FOUND", "Recurso não encontrado.", 404, audit=False)), status=404
    )


def error500(request):
    return JsonResponse(
        envelope(
            APIError("INTERNAL_ERROR", "Não foi possível concluir a operação.", 500, audit=False)
        ),
        status=500,
    )


def error400(request, exception=None):
    return JsonResponse(
        envelope(APIError("VALIDATION_ERROR", "Requisição inválida.", audit=False)), status=400
    )
