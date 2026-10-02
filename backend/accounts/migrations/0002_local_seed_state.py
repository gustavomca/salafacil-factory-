from django.db import migrations, models
from django.utils import timezone


def preserve_existing_installation(apps, schema_editor):
    """Legacy rooms can be renamed/duplicated; their editable names are not seed IDs."""
    Room = apps.get_model("rooms", "Room")
    User = apps.get_model("accounts", "User")
    LocalSeedState = apps.get_model("accounts", "LocalSeedState")
    database = schema_editor.connection.alias
    already_populated = (
        Room.objects.using(database).exists()
        or User.objects.using(database)
        .filter(
            models.Q(email__iexact="admin@salafacil.local")
            | models.Q(email__iexact="membro@salafacil.local")
        )
        .exists()
    )
    if already_populated:
        LocalSeedState.objects.using(database).get_or_create(key="local_rooms_v1")


class Migration(migrations.Migration):
    dependencies = [("accounts", "0001_initial"), ("rooms", "0001_initial")]

    operations = [
        migrations.CreateModel(
            name="LocalSeedState",
            fields=[
                ("key", models.CharField(max_length=40, primary_key=True, serialize=False)),
                ("completed_at", models.DateTimeField(default=timezone.now)),
            ],
        ),
        migrations.RunPython(preserve_existing_installation, migrations.RunPython.noop),
    ]
