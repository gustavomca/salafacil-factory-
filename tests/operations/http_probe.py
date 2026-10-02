"""Real HTTP/TLS probes. Secrets only in ephemeral runtime state, never printed."""
import datetime as dt
import http.client
import json
import os
import ssl
import sys
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlsplit


class Client:
    def __init__(self, base, source=None, cookies=None):
        self.base = base
        self.url = urlsplit(base)
        self.source = source
        self.cookies = cookies or {}
        self.token = None

    def request(self, method, path, body=None, expected=200, extra=None):
        headers = {"Accept": "application/json"}
        if self.cookies:
            headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["X-CSRFToken"] = self.token
        if method not in {"GET", "HEAD"}:
            headers["Origin"] = self.base
        if extra:
            headers.update(extra)
        kwargs = {"timeout": 30}
        if self.source:
            kwargs["source_address"] = (self.source, 0)
        if self.url.scheme == "https":
            kwargs["context"] = ssl.create_default_context(cafile=os.environ["TLS_CA"])
            conn = http.client.HTTPSConnection(self.url.hostname, self.url.port, **kwargs)
        else:
            conn = http.client.HTTPConnection(self.url.hostname, self.url.port, **kwargs)
        conn.request(method, path, json.dumps(body).encode() if body is not None else None, headers)
        response = conn.getresponse()
        content = response.read()
        response_headers = response.headers
        for raw in response_headers.get_all("Set-Cookie", []):
            parsed = SimpleCookie()
            parsed.load(raw)
            for key, item in parsed.items():
                if item.value:
                    self.cookies[key] = item.value
                else:
                    self.cookies.pop(key, None)
        # Do not print response bodies (they may include CSRF/user fields).
        assert response.status == expected, f"{method} {path.split('?')[0]}: expected {expected}, got {response.status}"
        conn.close()
        return (json.loads(content) if content else None), response_headers

    def csrf(self):
        data, _ = self.request("GET", "/api/session/csrf")
        self.token = data["csrf_token"]
        return data

    def login(self, email, password):
        self.csrf()
        data, headers = self.request("POST", "/api/session/login", {"email": email, "password": password})
        self.csrf()
        return data, headers


runtime = Path(os.environ.get("RUNTIME_DIRECTORY", "/runtime"))
mode = sys.argv[1]
base = os.environ.get("BASE_URL", "http://web:8080")
if mode == "prepare-local":
    client = Client(base)
    client.login("admin@salafacil.local", "AdminLocal!2026")
    room, _ = client.request("POST", "/api/rooms", {
        "name": "Persistência operacional", "description": "Fixture isolada",
        "capacity": 6, "location": "Teste Docker", "resources": ["whiteboard"],
    }, expected=201)
    client.request("POST", "/api/rooms", {
        "name": "Sala Jardim", "description": "Duplicata legítima por API",
        "capacity": 4, "location": "Teste seed", "resources": [],
    }, expected=201)
    aurora, _ = client.request("GET", "/api/rooms?search=Sala%20Aurora")
    assert aurora["count"] == 1
    renamed_id = aurora["results"][0]["id"]
    client.request("PATCH", f"/api/rooms/{renamed_id}", {"name": "Nome preservado após reinício"})
    start = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=2)).replace(microsecond=0)
    booking, _ = client.request("POST", "/api/reservations", {
        "room_id": room["id"], "title": "Reserva preservada após restart/restore",
        "description": "", "starts_at": start.isoformat(),
        "ends_at": (start + dt.timedelta(hours=1)).isoformat(), "participants": 4,
    }, expected=201)
    state = {"cookies": client.cookies, "booking": booking["id"], "room": room["id"], "renamed_id": renamed_id}
    (runtime / "local-state.json").write_text(json.dumps(state))
    (runtime / "local-state.json").chmod(0o600)
    print("Operations prepare: persisted reservation and session created through real HTTP.")
elif mode == "verify-local":
    state = json.loads((runtime / "local-state.json").read_text())
    client = Client(base, cookies=state["cookies"])
    user, _ = client.request("GET", "/api/session/me")
    assert user["user"]["role"] == "admin", "Session did not survive restart/restore"
    booking, _ = client.request("GET", f"/api/reservations/{state['booking']}")
    assert booking["status"] == "confirmed" and booking["room"]["id"] == state["room"]
    renamed, _ = client.request("GET", f"/api/rooms/{state['renamed_id']}")
    assert renamed["name"] == "Nome preservado após reinício"
    absent, _ = client.request("GET", "/api/rooms?search=Sala%20Aurora")
    duplicate, _ = client.request("GET", "/api/rooms?search=Sala%20Jardim")
    assert absent["count"] == 0 and duplicate["count"] == 2
    print("Operations persistence: original session and reservation survived.")
elif mode == "tls":
    password = (runtime / "admin-password.txt").read_text().strip()
    client = Client(base, source="127.0.0.3")
    # Host network + socket receives real source IP; forged XFF must be overwritten.
    data, csrf_headers = client.request("GET", "/api/session/csrf", extra={"X-Forwarded-For": "invalid,forged"})
    assert "csrf_token" in data
    csrf_cookies = []
    for raw in csrf_headers.get_all("Set-Cookie", []):
        parsed = SimpleCookie(); parsed.load(raw)
        csrf_cookies.extend(value for key, value in parsed.items() if "csrf" in key)
    assert csrf_cookies and all(c["secure"] and c["httponly"] and c["samesite"].lower() == "lax" for c in csrf_cookies)
    _, headers = client.login("admin@salafacil.test", password)
    session_cookies = []
    for raw in headers.get_all("Set-Cookie", []):
        parsed = SimpleCookie(); parsed.load(raw)
        for key, value in parsed.items():
            if "session" in key:
                session_cookies.append(value)
    assert session_cookies and all(c["secure"] and c["httponly"] and c["samesite"].lower() == "lax" for c in session_cookies)
    _, headers = client.request("GET", "/api/dashboard?date=2026-10-01&tz=America%2FSao_Paulo")
    assert "max-age" in headers["Strict-Transport-Security"]
    assert "script-src 'self'" in headers["Content-Security-Policy"]
    client.request("POST", "/api/session/logout", {}, expected=403, extra={"Origin": "https://untrusted.example"})
    # Exhaust one real source with repeated denied attempts; same forged header from
    # another bound source must not inherit that network's budget.
    limited = Client(base, source="127.0.0.2")
    limited.csrf()
    for index in range(60):
        status = 401 if index < 10 else 429
        limited.request("POST", "/api/session/login", {"email": "limit-probe@salafacil.test", "password": "invalid-test-password"}, expected=status, extra={"X-Forwarded-For": "203.0.113.10"})
    limited.request("POST", "/api/session/login", {"email": "admin@salafacil.test", "password": password}, expected=429, extra={"X-Forwarded-For": "203.0.113.10"})
    other = Client(base, source="127.0.0.3")
    other.csrf()
    other.request("POST", "/api/session/login", {"email": "admin@salafacil.test", "password": password}, extra={"X-Forwarded-For": "203.0.113.10"})
    print("Operations TLS: verified certificate, Secure/HttpOnly/Lax session, CSRF rejection, CSP, real source separation and forged-XFF overwrite passed.")
else:
    raise SystemExit("Unknown probe mode")
