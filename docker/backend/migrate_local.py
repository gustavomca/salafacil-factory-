"""Automatic migrations only on a fresh database; existing installations are explicit."""
import os
import sys

sys.path.insert(0, "/app")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
import django

django.setup()
from django.core.management import call_command
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.recorder import MigrationRecorder

executor = MigrationExecutor(connection)
plan = executor.migration_plan(executor.loader.graph.leaf_nodes())
if os.environ.get("APP_ENV") == "production":
    if plan:
        print("PRODUCTION_MIGRATIONS_PENDING: execute migrate manualmente antes de iniciar.", file=sys.stderr)
        raise SystemExit(1)
    call_command("migrate", check_unapplied=True, interactive=False)
    print("Migrations conferidas; seed omitido em produção.")
    raise SystemExit(0)
if plan and MigrationRecorder(connection).applied_migrations():
    print(
        "LOCAL_MIGRATIONS_PENDING: instalação existente exige backup, migrate --plan "
        "e execução explícita de migrate antes de iniciar.",
        file=sys.stderr,
    )
    raise SystemExit(1)
if plan:
    call_command("migrate", interactive=False)
else:
    print("Migrations locais conferidas; nenhuma alteração pendente.")
