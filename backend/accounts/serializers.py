from rest_framework import serializers

from core.serializers import StrictSerializer, StrictText


class LoginInput(StrictSerializer):
    email = serializers.EmailField(max_length=254)
    password = StrictText(max_length=128, trim_whitespace=False)

    def validate_email(self, value):
        return value.strip().lower()


def user_data(user):
    return {"id": user.id, "name": user.name, "email": user.email, "role": user.role}
