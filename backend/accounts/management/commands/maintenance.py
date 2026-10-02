from datetime import timedelta

from django.contrib.sessions.models import Session
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from accounts.models import LoginBucket


class Command(BaseCommand):
    help = "Remove lotes limitados de sessões expiradas e buckets vencidos há mais de 24 horas."

    def add_arguments(self, parser):
        parser.add_argument("--batch-size", type=int, default=1000)

    def handle(self, *args, **options):
        from django.core.management.base import CommandError

        size = options["batch_size"]
        if size < 1 or size > 10000:
            raise CommandError("batch-size deve estar entre 1 e 10000.")
        now = timezone.now()
        with transaction.atomic():
            session_ids = list(
                Session.objects.filter(expire_date__lt=now)
                .order_by("expire_date")
                .values_list("pk", flat=True)[:size]
            )
            bucket_ids = list(
                LoginBucket.objects.filter(window_start__lt=now - timedelta(hours=24, minutes=15))
                .order_by("window_start")
                .values_list("pk", flat=True)[:size]
            )
            sessions, _ = Session.objects.filter(pk__in=session_ids).delete()
            buckets, _ = LoginBucket.objects.filter(pk__in=bucket_ids).delete()
        self.stdout.write(f"Manutenção: {sessions} sessões e {buckets} buckets removidos.")
