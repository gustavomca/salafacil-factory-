class APIError(Exception):
    def __init__(
        self,
        code,
        message,
        status=400,
        details=None,
        *,
        resource="http",
        resource_id=None,
        audit=True,
        headers=None,
    ):
        self.code = code
        self.message = message
        self.status = status
        self.details = details or {}
        self.resource = resource
        self.resource_id = resource_id
        self.audit = audit
        self.headers = headers or {}
        super().__init__(code)


def invalid(field, message):
    return APIError(
        "VALIDATION_ERROR", "Confira os campos informados.", details={field: [message]}, audit=False
    )


def forbidden(resource="http", resource_id=None):
    return APIError(
        "FORBIDDEN",
        "Você não tem permissão para esta operação.",
        403,
        resource=resource,
        resource_id=resource_id,
    )


def not_found():
    return APIError("NOT_FOUND", "Recurso não encontrado.", 404, audit=False)
