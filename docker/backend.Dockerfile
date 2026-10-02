FROM python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 app && useradd --uid 10001 --gid app --no-create-home app \
    && mkdir -p /run/salafacil && chown app:app /run/salafacil && chmod 0770 /run/salafacil
COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY --chown=app:app backend/ /app/
COPY --chmod=755 docker/backend/entrypoint.sh /opt/salafacil/entrypoint.sh
COPY docker/backend/health.py docker/backend/gunicorn.conf.py docker/backend/migrate_local.py /opt/salafacil/
USER 10001:10001
ENTRYPOINT ["/opt/salafacil/entrypoint.sh"]
CMD ["serve"]

FROM runtime AS test
USER root
COPY backend/requirements-dev.txt /app/requirements-dev.txt
RUN pip install --no-cache-dir -r requirements-dev.txt
COPY tests/operations/ /opt/checks/
USER 10001:10001
