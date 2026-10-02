"""Readiness over the same private transport, without publishing another listener."""
import http.client
import os
import socket


class UnixConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect("/run/salafacil/gunicorn.sock")


connection = UnixConnection("localhost", timeout=5) if os.environ.get("BACKEND_TRANSPORT") == "unix" else http.client.HTTPConnection("127.0.0.1", 8000, timeout=5)
host = os.environ.get("ALLOWED_HOSTS", "localhost").split(",")[0].strip()
connection.request("GET", "/health/ready", headers={"Host": host, "X-Forwarded-Proto": "https" if os.environ.get("APP_ENV") == "production" else "http"})
response = connection.getresponse()
assert response.status == 200, f"Readiness failed: {response.status}"
connection.close()
