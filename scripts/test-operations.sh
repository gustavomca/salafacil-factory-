#!/usr/bin/env bash
# All data/volumes below are exclusively created by this isolated test invocation.
set -euo pipefail
cd "$(dirname "$0")/.."
task_id="$(date +%s)-$$"
task_local="sf-salafacil-ops-$task_id"
task_restore="sf-salafacil-restore-$task_id"
task_prod="sf-salafacil-tls-$task_id"
export IMAGE_TAG="$task_local"
task_runtime="$PWD/.factory/runtime/operations-$task_id"
mkdir -p "$task_runtime"
chmod 700 "$task_runtime"
export TEST_WEB_PORT="${TEST_WEB_PORT:-18082}"
dc() { docker compose -p "$task_local" -f compose.yaml -f compose.test.yaml "$@"; }
restore() { docker compose -p "$task_restore" -f compose.yaml -f compose.test.yaml "$@"; }
prod() { docker compose --env-file "$task_runtime/production.env" -p "$task_prod" -f compose.yaml -f compose.production.yaml "$@"; }
cleanup() {
  dc logs --no-color --tail=35 backend web || true
  dc down -v --remove-orphans >/dev/null || true
  restore down -v --remove-orphans >/dev/null || true
  if test -f "$task_runtime/production.env"; then
    prod logs --no-color --tail=35 backend web || true
    prod down -v --remove-orphans >/dev/null || true
  fi
}
trap cleanup EXIT
dc build db init backend web backend-test
dc up -d --wait web
docker run --rm --network host -e TEST_WEB_PORT --entrypoint python "salafacil-backend:$IMAGE_TAG" -c 'import os,urllib.request; r=urllib.request.urlopen("http://127.0.0.1:"+os.environ["TEST_WEB_PORT"]+"/health/ready",timeout=10); assert r.status==200; print("Operations host: published loopback port responds.")'
probe() { dc run --rm --no-deps --user "$(id -u):$(id -g)" -e BASE_URL=http://web:8080 -v "$task_runtime:/runtime" backend-test python /opt/checks/http_probe.py "$@"; }
probe prepare-local
dc exec -T backend python manage.py shell -c 'from accounts.models import User; from rooms.models import Room; u=User.objects.get(email="membro@salafacil.local"); u.set_password("ChangedSeedPassword2026!"); u.is_active=False; u.name="Preservar conta"; u.save(); r=Room.objects.order_by("id").first(); r.description="Preservar descrição"; r.save()'
dc exec -T backend python manage.py seed_local
dc exec -T backend python manage.py seed_local
dc exec -T backend python manage.py migrate --noinput
dc exec -T backend python manage.py shell -c 'from accounts.models import User; from rooms.models import Room; from django.db import connection; u=User.objects.get(email="membro@salafacil.local"); assert not u.is_active and u.name=="Preservar conta" and u.check_password("ChangedSeedPassword2026!"); assert Room.objects.order_by("id").first().description=="Preservar descrição"; c=connection.cursor(); c.execute("SELECT rolsuper,rolcreatedb FROM pg_roles WHERE rolname=current_user"); assert c.fetchone()==(False,True); print("Operations seed: preserved account and room across repeated seed/migrations; non-superuser app confirmed.")'
# Controlled migration-ledger fault in this disposable database: real executor
# sees pending work on an existing install; init must refuse before running DDL.
dc exec -T backend python manage.py shell -c 'from django.db.migrations.recorder import MigrationRecorder; assert MigrationRecorder.Migration.objects.filter(app="sessions",name="0001_initial").update(name="0001_guard_fixture")==1'
if dc run --rm --no-deps init > "$task_runtime/local-migration-guard.log" 2>&1; then
  printf '%s\n' 'FAIL: local existing installation migrated automatically.' >&2; exit 1
fi
cat "$task_runtime/local-migration-guard.log"
grep -q 'LOCAL_MIGRATIONS_PENDING' "$task_runtime/local-migration-guard.log"
dc exec -T backend python manage.py shell -c 'from django.db.migrations.recorder import MigrationRecorder; from django.contrib.sessions.models import Session; assert Session.objects.exists(); assert MigrationRecorder.Migration.objects.filter(app="sessions",name="0001_guard_fixture").update(name="0001_initial")==1; print("Operations migration guard: existing install refused pending plan; session table/data preserved.")'
dc restart db backend web
dc up -d --wait web
probe verify-local
dc exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U postgres -d "$APP_DB_NAME" -Fc' > "$task_runtime/backup.dump"
test -s "$task_runtime/backup.dump"
dc stop web backend
restore up -d --wait db
restore exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U postgres -d "$APP_DB_NAME" --exit-on-error --clean --if-exists' < "$task_runtime/backup.dump"
restore up -d --wait web
docker run --rm --network host -e TEST_WEB_PORT --entrypoint python "salafacil-backend:$IMAGE_TAG" -c 'import os,urllib.request; r=urllib.request.urlopen("http://127.0.0.1:"+os.environ["TEST_WEB_PORT"]+"/health/ready",timeout=10); assert r.status==200; print("Operations restore host: published loopback port responds.")'
restore run --rm --no-deps --user "$(id -u):$(id -g)" -e BASE_URL=http://web:8080 -v "$task_runtime:/runtime" backend-test python /opt/checks/http_probe.py verify-local
printf '%s\n' 'Operations backup: pg_dump restored into independent database/volume; original session and booking verified via HTTP.'
restore down -v --remove-orphans

# Generate independent TLS/database/application secrets inside the prepared image.
docker run --rm --user "$(id -u):$(id -g)" --network none \
  -e HOST_RUNTIME_DIRECTORY="$task_runtime" -v "$task_runtime:/runtime" \
  --entrypoint python "salafacil-backend-test:$IMAGE_TAG" /opt/checks/prepare_prod.py
docker run --rm --user 0 --network none -v "$task_runtime/tls:/tls" --entrypoint sh "salafacil-backend-test:$IMAGE_TAG" \
  -c 'chgrp -R 10001 /tls && chmod 750 /tls && chmod 640 /tls/server.key && chmod 644 /tls/server.crt'
prod config --quiet
prod up -d --wait db
# Must refuse serving while migrations are pending in production.
if prod up -d --wait backend; then
  printf '%s\n' 'FAIL: production started without manual migrations.' >&2
  exit 1
fi
prod logs --no-color init > "$task_runtime/production-migration-guard.log"
cat "$task_runtime/production-migration-guard.log"
grep -q 'PRODUCTION_MIGRATIONS_PENDING' "$task_runtime/production-migration-guard.log"
prod exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -d "$APP_DB_NAME" -Atc "SELECT to_regclass('\''public.django_migrations'\'') IS NULL"' | grep -qx t
prod run --rm --no-deps init python manage.py migrate --plan
prod run --rm --no-deps init python manage.py migrate --noinput
prod run --rm --no-deps -T init python manage.py provision_initial_admin --email admin@salafacil.test --name 'Admin de teste' --password-stdin < "$task_runtime/admin-password.txt"
printf '%s\n' 'DifferentPassword2026!NotApplied' | prod run --rm --no-deps -T init python manage.py provision_initial_admin --email admin@salafacil.test --name 'Não sobrescrever' --password-stdin
if prod run --rm --no-deps init python manage.py seed_local; then
  printf '%s\n' 'FAIL: production accepted local seed.' >&2
  exit 1
fi
prod run --rm --no-deps init python manage.py shell -c 'from accounts.models import User; from django.db import connection; assert User.objects.count()==1 and not User.objects.filter(email__endswith="@salafacil.local").exists(); c=connection.cursor(); c.execute("SELECT rolsuper,rolcreatedb FROM pg_roles WHERE rolname=current_user"); assert c.fetchone()==(False,False); print("Operations production: one initial admin only, no demo seed, non-superuser/non-createdb app.")'
prod up -d --wait web
for task_bad_ip in 0.0.0.0 255.255.255.255 224.0.0.1 127.00.0.1; do
  if docker run --rm --network none --read-only --tmpfs /tmp -e APP_ENV=production -e "WEB_BIND_IPV4=$task_bad_ip" "salafacil-web:$IMAGE_TAG" > "$task_runtime/invalid-bind.log" 2>&1; then
    printf '%s\n' 'FAIL: invalid production bind accepted.' >&2; exit 1
  fi
  grep -q 'IPv4 unicast específico' "$task_runtime/invalid-bind.log"
done
printf '%s\n' 'Operations bind: wildcard, multicast, broadcast and noncanonical IPv4 rejected.'
prod exec -T backend python -c 'import os,stat; p="/run/salafacil/gunicorn.sock"; s=os.stat(p); assert stat.S_ISSOCK(s.st_mode) and stat.S_IMODE(s.st_mode)==0o660 and s.st_gid==10001; d=os.stat("/run/salafacil"); assert stat.S_IMODE(d.st_mode)==0o770; assert os.getuid()==10001; print("Operations socket: 0660 and directory0770, app UID10001.")'
prod exec -T backend python -c 'from pathlib import Path; rows=[r for p in ("/proc/net/tcp","/proc/net/tcp6") for r in Path(p).read_text().splitlines()[1:]]; listeners=[r for r in rows if r.split()[3]=="0A"]; assert all(r.split()[1].split(":")[0]=="0B00007F" for r in listeners); print("Operations transport: no application TCP listener, only Docker embedded DNS if present.")'
prod exec -T backend python -c 'import http.client,socket,json; C=type("U",(http.client.HTTPConnection,),{"connect":lambda s:setattr(s,"sock",socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)) or s.sock.connect("/run/salafacil/gunicorn.sock")});
for value in (None,"invalid","127.0.0.1,127.0.0.2"):
 c=C("localhost"); h={"Host":"127.0.0.1","X-Forwarded-Proto":"https"}; h.update({"X-Forwarded-For":value} if value else {}); c.request("GET","/api/session/me",headers=h); r=c.getresponse(); assert r.status==503 and json.loads(r.read())["error"]["code"]=="PROXY_IDENTITY_INVALID"; c.close()
print("Operations proxy: missing, invalid and multiple identities rejected over actual Unix socket.")'
task_web_id="$(prod ps -q web)"
test "$(docker inspect --format '{{.Config.User}} {{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}}' "$task_web_id")" = '10001:10001 host true'
if docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$task_web_id" | grep -Eq '^(SECRET_KEY|DB_PASSWORD|DB_ADMIN_PASSWORD)='; then
  printf '%s\n' 'FAIL: web received a backend secret.' >&2; exit 1
fi
for task_service in db backend; do
  test "$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$(prod ps -q "$task_service")")" = 0
done
docker run --rm --network host --user "$(id -u):$(id -g)" \
  -e BASE_URL=https://127.0.0.1:8443 -e TLS_CA=/runtime/tls/server.crt \
  -v "$task_runtime:/runtime" --entrypoint python "salafacil-backend-test:$IMAGE_TAG" /opt/checks/http_probe.py tls
printf '%s\n' 'Operations checks passed: setup/migrations/seed/restart/restore/TLS/CSRF/Unix/proxy/isolation configurations verified.'
