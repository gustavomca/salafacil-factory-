from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from accounts.models import LocalSeedState, User
from rooms.models import Room


class Command(BaseCommand):
    help = "Cria somente dados locais faltantes; nunca modifica registros existentes."

    def handle(self, *args, **options):
        if settings.APP_ENV == "production":
            raise CommandError("Seed local proibido em produção.")
        with transaction.atomic():
            # Cooperating seed invocations also serialize creation of demo rooms.
            from django.db import connection

            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_advisory_xact_lock(735210101)")
            for email, name, role, password in [
                ("admin@salafacil.local", "Administrador local", "admin", "AdminLocal!2026"),
                ("membro@salafacil.local", "Membro local", "member", "MembroLocal!2026"),
            ]:
                if not User.objects.filter(email__iexact=email).exists():
                    User.objects.create_user(email=email, name=name, role=role, password=password)
            if LocalSeedState.objects.filter(pk="local_rooms_v1").exists():
                self.stdout.write("Seed local verificado; dados existentes preservados.")
                return
            for name, capacity, location, resources, status, reason in [
                (
                    "Sala Aurora",
                    8,
                    "1º andar · Ala leste",
                    ["projector", "whiteboard"],
                    "active",
                    "",
                ),
                (
                    "Sala Horizonte",
                    16,
                    "2º andar · Ala norte",
                    ["projector", "videoconference", "whiteboard"],
                    "active",
                    "",
                ),
                ("Sala Jardim", 4, "Térreo · Pátio", ["whiteboard"], "active", ""),
                (
                    "Sala Brisa",
                    6,
                    "1º andar · Ala oeste",
                    ["videoconference"],
                    "blocked",
                    "Manutenção do equipamento de vídeo",
                ),
                ("Sala Cedro", 10, "2º andar · Ala sul", ["projector"], "inactive", ""),
            ]:
                Room.objects.create(
                    name=name,
                    **{
                        "description": "Espaço para encontros e trabalho em equipe.",
                        "capacity": capacity,
                        "location": location,
                        "resources": resources,
                        "status": status,
                        "blocked_reason": reason,
                    },
                )
            LocalSeedState.objects.create(key="local_rooms_v1")
        self.stdout.write("Seed local verificado; dados existentes preservados.")
