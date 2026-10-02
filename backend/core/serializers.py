import re
from datetime import datetime, timedelta

from django.utils import timezone
from rest_framework import serializers

from core.errors import invalid


class StrictSerializer(serializers.Serializer):
    def to_internal_value(self, data):
        if not isinstance(data, dict):
            raise serializers.ValidationError({"body": ["Envie um objeto JSON."]})
        extra = set(data) - set(self.fields)
        if extra:
            raise serializers.ValidationError({"body": ["Há campos não permitidos."]})
        return super().to_internal_value(data)


class StrictInteger(serializers.IntegerField):
    def to_internal_value(self, value):
        if not isinstance(value, int) or isinstance(value, bool):
            self.fail("invalid")
        return super().to_internal_value(value)


class StrictText(serializers.CharField):
    def to_internal_value(self, value):
        if not isinstance(value, str):
            self.fail("invalid")
        return super().to_internal_value(value)


class OffsetDateTime(serializers.DateTimeField):
    def to_internal_value(self, value):
        if not isinstance(value, str) or not re.search(r"(?:Z|[+-]\d{2}:\d{2})$", value):
            raise serializers.ValidationError("Informe uma data ISO 8601 com fuso.")
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (ValueError, OverflowError):
            raise serializers.ValidationError("Data inválida.") from None
        if timezone.is_naive(parsed):
            raise serializers.ValidationError("Informe o fuso da data.")
        return super().to_internal_value(value)


def interval(starts_at, ends_at, *, future=False):
    duration = ends_at - starts_at
    if duration < timedelta(minutes=15) or duration > timedelta(hours=8):
        raise invalid("ends_at", "A duração deve ser de 15 minutos a 8 horas.")
    if future and starts_at < timezone.now():
        raise invalid("starts_at", "Escolha um início futuro.")


def query_allowed(request, allowed):
    if set(request.query_params) - set(allowed) or any(
        len(request.query_params.getlist(k)) != 1 for k in request.query_params
    ):
        raise invalid("query", "Parâmetros não permitidos ou repetidos.")


def query_int(value, name, *, default=None, maximum=None):
    if value is None:
        return default
    if not re.fullmatch(r"[1-9][0-9]{0,18}", value):
        raise invalid(name, "Informe um inteiro positivo.")
    parsed = int(value)
    if maximum is not None and parsed > maximum:
        raise invalid(name, f"O máximo é {maximum}.")
    return parsed


def query_date(value, name):
    if value is None:
        return None
    try:
        return OffsetDateTime().run_validation(value)
    except serializers.ValidationError:
        raise invalid(name, "Informe uma data ISO 8601 com fuso.") from None


def query_interval(params):
    start, end = query_date(params.get("from"), "from"), query_date(params.get("to"), "to")
    if start and end and start >= end:
        raise invalid("to", "O fim deve ser posterior ao início.")
    return start, end


def paginate(request, queryset, serialize):
    page = query_int(request.query_params.get("page"), "page", default=1)
    size = query_int(request.query_params.get("page_size"), "page_size", default=20, maximum=100)
    count = queryset.count()
    if page > max(1, (count + size - 1) // size):
        raise invalid("page", "Página inválida.")

    def page_url(number):
        params = request.query_params.copy()
        params["page"] = str(number)
        return f"{request.path}?{params.urlencode()}"

    return {
        "count": count,
        "next": page_url(page + 1) if page * size < count else None,
        "previous": page_url(page - 1) if page > 1 else None,
        "results": [serialize(x) for x in queryset[(page - 1) * size : page * size]],
    }


def iso(value):
    return (
        value.astimezone(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z")
        if value
        else None
    )
