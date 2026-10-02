import logging
import time
import uuid

from django.http import JsonResponse

from core.errors import APIError
from core.http import envelope
from core.identity import network_key

logger = logging.getLogger("salafacil")


class RequestContextMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        started = time.monotonic()
        request.request_id = str(uuid.uuid4())
        try:
            if request.path.startswith("/api"):
                raw = request.META.get("HTTP_X_FORWARDED_FOR", "")
                if not raw or "," in raw or raw != raw.strip() or "%" in raw:
                    raise APIError(
                        "PROXY_IDENTITY_INVALID",
                        "Serviço temporariamente indisponível.",
                        503,
                        audit=False,
                    )
                request.network_key = network_key(raw)
                try:
                    length = int(request.META.get("CONTENT_LENGTH") or "0")
                except ValueError:
                    raise APIError(
                        "VALIDATION_ERROR", "Requisição inválida.", audit=False
                    ) from None
                if length > 32768 or length < 0:
                    raise APIError("VALIDATION_ERROR", "O corpo deve ter até 32 KiB.", audit=False)
            response = self.get_response(request)
        except APIError as error:
            request.error_code = error.code
            response = JsonResponse(envelope(error), status=error.status)
        response["X-Request-ID"] = request.request_id
        response["X-Frame-Options"] = "DENY"
        if request.path.startswith("/api"):
            response["Cache-Control"] = "no-store"
        route = getattr(getattr(request, "resolver_match", None), "url_name", None) or "unmatched"
        logger.info(
            "request",
            extra={
                "safe_event": "http_request",
                "request_id": request.request_id,
                "method": request.method
                if request.method in {"GET", "POST", "PATCH", "DELETE", "PUT", "HEAD", "OPTIONS"}
                else "OTHER",
                "route": route,
                "status": response.status_code,
                "duration_ms": round((time.monotonic() - started) * 1000, 2),
                "error_code": getattr(request, "error_code", None),
            },
        )
        return response
