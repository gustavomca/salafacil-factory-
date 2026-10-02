"""Generate ephemeral production-profile test material; never print secrets."""
import os
from pathlib import Path
import secrets
import subprocess

root = Path("/runtime")
tls = root / "tls"
tls.mkdir(exist_ok=True)
subprocess.run([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", str(tls / "server.key"), "-out", str(tls / "server.crt"),
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
values = {
    "APP_ENV": "production", "DEBUG": "false", "SECRET_KEY": secrets.token_urlsafe(64),
    "DB_PASSWORD": secrets.token_urlsafe(40), "DB_ADMIN_PASSWORD": secrets.token_urlsafe(40),
    "DB_NAME": "salafacilprod", "DB_USER": "salafacilprod", "ALLOWED_HOSTS": "127.0.0.1,localhost",
    "CSRF_TRUSTED_ORIGINS": "https://127.0.0.1:8443", "WEB_BIND_IPV4": "127.0.0.1",
    "TLS_DIRECTORY": os.environ["HOST_RUNTIME_DIRECTORY"] + "/tls",
}
(root / "production.env").write_text("\n".join(f"{k}={v}" for k,v in values.items()) + "\n")
(root / "production.env").chmod(0o600)
(root / "admin-password.txt").write_text(secrets.token_urlsafe(24))
(root / "admin-password.txt").chmod(0o600)
print("Ephemeral TLS certificate and independent production-profile secrets generated.")
