import getpass
import sys

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.core.validators import validate_email
from django.db import connection, transaction

from accounts.models import User, UserManager
from audit.services import emit


class Command(BaseCommand):
    help = "Provisiona somente o primeiro admin; nunca altera contas ou senhas existentes."

    def add_arguments(self, parser):
        parser.add_argument("--email", required=True)
        parser.add_argument("--name", required=True)
        group = parser.add_mutually_exclusive_group()
        group.add_argument("--password-stdin", action="store_true")
        group.add_argument("--password-file")

    def handle(self, *args, **options):
        email, name = UserManager.normalize_email(options["email"]), options["name"].strip()
        try:
            validate_email(email)
            if not 1 <= len(name) <= 120:
                raise ValidationError("Nome inválido.")
        except ValidationError:
            raise CommandError("Nome ou e-mail inválido.") from None
        if options["password_stdin"]:
            password = sys.stdin.readline(130).rstrip("\r\n")
        elif options["password_file"]:
            try:
                with open(options["password_file"], encoding="utf-8") as source:
                    password = source.read(130).rstrip("\r\n")
            except OSError:
                raise CommandError("Não foi possível ler o secret.") from None
        else:
            password = getpass.getpass("Senha inicial: ")
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_advisory_xact_lock(735210102)")
            existing = User.objects.filter(email=email, role="admin").first()
            if existing:
                self.stdout.write("conta existente, senha não alterada")
                return
            if User.objects.exists():
                raise CommandError("Instalação já possui contas; provisionamento recusado.")
            candidate = User(name=name, email=email, role="admin")
            try:
                if len(password) > 128:
                    raise ValidationError("Senha longa.")
                validate_password(password, candidate)
            except ValidationError:
                raise CommandError("Senha não atende aos requisitos de segurança.") from None
            candidate.set_password(password)
            candidate.save()
            emit(
                "account.provisioned",
                resource="user",
                resource_id=candidate.pk,
                metadata={"reason_code": "INITIAL_SETUP"},
            )
        self.stdout.write("Admin inicial provisionado.")
