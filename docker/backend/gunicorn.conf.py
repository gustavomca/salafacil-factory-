import os

bind = "unix:/run/salafacil/gunicorn.sock" if os.environ.get("BACKEND_TRANSPORT") == "unix" else "0.0.0.0:8000"
workers = int(os.environ.get("WEB_CONCURRENCY", "2"))
worker_class = "sync"
timeout = 40
graceful_timeout = 25
keepalive = 2
umask = 0o117  # socket 0660; directory ownership is prepared as 10001:10001/0770.
accesslog = None  # Request logging is sanitized by application middleware.
errorlog = "-"
capture_output = False
control_socket_disable = True  # No management listener or writable home in runtime.
forwarded_allow_ips = "*"  # Only private proxy reaches TCP/Unix upstream; XFF validated in Django.
