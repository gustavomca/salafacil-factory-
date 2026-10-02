import hashlib
import hmac
import ipaddress
from datetime import UTC, datetime

from django.conf import settings

from core.errors import APIError


def canonical_network(raw):
    try:
        address = ipaddress.ip_address(raw)
    except (ValueError, TypeError):
        raise APIError(
            "PROXY_IDENTITY_INVALID", "Serviço temporariamente indisponível.", 503, audit=False
        ) from None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    if isinstance(address, ipaddress.IPv6Address):
        return str(ipaddress.ip_network(f"{address}/64", strict=False))
    return str(address)


def protected_key(kind, value):
    derivation = hmac.new(
        settings.SECRET_KEY.encode(), b"salafacil-security-identifiers-v1", hashlib.sha256
    ).digest()
    return hmac.new(derivation, f"{kind}:{value}".encode(), hashlib.sha256).hexdigest()


def network_key(raw):
    return protected_key("network", canonical_network(raw))


def window_start(now):
    return datetime.fromtimestamp(int(now.timestamp()) // 900 * 900, tz=UTC)
