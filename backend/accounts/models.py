from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.db import models
from django.db.models.functions import Lower
from django.utils import timezone


class UserManager(BaseUserManager):
    @classmethod
    def normalize_email(cls, email):
        return (email or "").strip().lower()

    def create_user(self, email, password=None, **extra):
        user = self.model(email=self.normalize_email(email), **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def get_by_natural_key(self, username):
        return self.get(email=self.normalize_email(username))


class User(AbstractBaseUser):
    name = models.CharField(max_length=120)
    email = models.EmailField(max_length=254, unique=True)
    role = models.CharField(
        max_length=10, choices=[("admin", "Admin"), ("member", "Membro")], default="member"
    )
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    objects = UserManager()
    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["name"]

    class Meta:
        constraints = [
            models.UniqueConstraint(Lower("email"), name="user_email_ci_unique"),
            models.CheckConstraint(
                condition=models.Q(role__in=["admin", "member"]), name="user_valid_role"
            ),
        ]

    def save(self, *args, **kwargs):
        self.email = UserManager.normalize_email(self.email)
        return super().save(*args, **kwargs)


class LoginBucket(models.Model):
    kind = models.CharField(max_length=10)
    key = models.CharField(max_length=64)
    identity_key = models.CharField(max_length=64, null=True, db_index=True)
    network_key = models.CharField(max_length=64, null=True, db_index=True)
    window_start = models.DateTimeField()
    count = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["kind", "key", "window_start"], name="login_bucket_unique"
            ),
            models.CheckConstraint(
                condition=models.Q(kind__in=["ip", "pair", "identity"]), name="login_bucket_kind"
            ),
        ]
        indexes = [models.Index(fields=["window_start"], name="login_bucket_window")]


class LocalSeedState(models.Model):
    """Stable local initialization marker; never inferred from editable room names."""

    key = models.CharField(primary_key=True, max_length=40)
    completed_at = models.DateTimeField(default=timezone.now)
