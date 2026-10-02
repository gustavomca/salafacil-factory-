from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.core.validators import validate_email
from django.db import transaction
from django.db.models import Case, IntegerField, Value, When

from accounts.models import LoginBucket, UserManager
from audit.services import emit
from core.errors import APIError
from core.identity import network_key, protected_key


class Command(BaseCommand):
    help = "Desbloqueia um alvo explícito, preservando auditoria e outras identidades/redes."

    def add_arguments(self, parser):
        group = parser.add_mutually_exclusive_group(required=True)
        group.add_argument("--identity")
        group.add_argument("--network")
        parser.add_argument(
            "--reason",
            choices=["OWNER_REQUEST", "SECURITY_RESPONSE", "SUPPORT_RECOVERY"],
            required=True,
        )
        parser.add_argument("--confirm", action="store_true")

    def handle(self, *args, **options):
        if not options["confirm"]:
            raise CommandError("Confirme o alvo com --confirm.")
        if options["identity"]:
            identity = UserManager.normalize_email(options["identity"])
            try:
                validate_email(identity)
            except ValidationError:
                raise CommandError("Identidade inválida.") from None
            filters = {"identity_key": protected_key("identity", identity)}
            kind = "identity"
        else:
            try:
                raw = options["network"]
                # IPv6 /64 is accepted as an explicit network target, never broader.
                if "/" in raw:
                    import ipaddress

                    network = ipaddress.ip_network(raw, strict=True)
                    if network.version != 6 or network.prefixlen != 64:
                        raise ValueError
                    raw = str(network.network_address)
                filters = {"network_key": network_key(raw)}
            except (APIError, ValueError):
                raise CommandError("Endereço ou prefixo IPv6 /64 inválido.") from None
            kind = "network"
        with transaction.atomic():
            # Keep bucket rows: concurrent logins cannot keep an orphaned lock on a deleted row.
            rows = list(
                LoginBucket.objects.select_for_update()
                .filter(**filters)
                .order_by(
                    Case(
                        When(kind="ip", then=Value(0)),
                        When(kind="identity", then=Value(1)),
                        default=Value(2),
                        output_field=IntegerField(),
                    ),
                    "key",
                    "window_start",
                )
            )
            LoginBucket.objects.filter(pk__in=[row.pk for row in rows]).update(count=0)
            emit(
                "login.limit_unlocked",
                resource="login_limit",
                metadata={"reason_code": options["reason"], "target_kind": kind},
            )
        self.stdout.write("Alvo desbloqueado; auditoria preservada.")
