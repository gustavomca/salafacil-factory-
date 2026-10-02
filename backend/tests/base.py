import uuid
from datetime import timedelta

from django.test import Client, TransactionTestCase
from django.utils import timezone

from accounts.models import User
from core.serializers import iso
from rooms.models import Room

PASSWORD = "SecretTest!Pass2026"


class APITransactionTest(TransactionTestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            email="admin@example.test", name="Admin", role="admin", password=PASSWORD
        )
        self.member = User.objects.create_user(
            email="member@example.test", name="Membro", password=PASSWORD
        )
        self.other = User.objects.create_user(
            email="other@example.test", name="Outro", password=PASSWORD
        )
        self.room = Room.objects.create(
            name="Sala", capacity=10, location="1º andar", resources=["whiteboard"]
        )
        self.client = self.client_for(self.member)
        self.admin_client = self.client_for(self.admin)
        self.other_client = self.client_for(self.other)

    def client_for(self, user=None, address="192.0.2.1"):
        client = Client(enforce_csrf_checks=True, HTTP_X_FORWARDED_FOR=address)
        if user:
            client.force_login(user)
        response = client.get("/api/session/csrf")
        client.defaults["HTTP_X_CSRFTOKEN"] = response.json()["csrf_token"]
        return client

    def post(self, url, body=None, client=None):
        return (client or self.client).post(url, body or {}, content_type="application/json")

    def payload(self, room=None, **extra):
        start = timezone.now() + timedelta(days=1)
        return {
            "room_id": (room or self.room).pk,
            "title": f"Reunião {uuid.uuid4()}",
            "description": "Texto privado",
            "starts_at": iso(start),
            "ends_at": iso(start + timedelta(hours=1)),
            "participants": 3,
            **extra,
        }

    def reserve(self, client=None, **extra):
        response = self.post("/api/reservations", self.payload(**extra), client)
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def assert_error(self, response, status, code):
        self.assertEqual(response.status_code, status, response.content)
        self.assertEqual(response.json()["error"]["code"], code)
