#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# A committed source tree is required so this truly reproduces a clean checkout.
if test -n "$(git status --porcelain --untracked-files=all -- . ':!.factory')"; then
  printf '%s\n' 'Commit the candidate source before clean-checkout reproduction.' >&2
  exit 1
fi
task_root="$PWD"
task_id="$(date +%s)-$$"
task_clone="$task_root/.factory/runtime/reproduce-$task_id"
task_project="sf-salafacil-reproduce-$task_id"
export IMAGE_TAG="$task_project"
mkdir -p "$task_root/.factory/runtime"
git clone --local --no-hardlinks "$task_root" "$task_clone"
cd "$task_clone"
test -z "$(git status --porcelain --untracked-files=all)"
task_env_contents="$(< .env.example)"
printf '%s\n' "${task_env_contents//8080/18084}" > .env
dc() { docker compose -p "$task_project" "$@"; }
cleanup() { dc logs --no-color --tail=10 init backend web || true; dc down -v --remove-orphans >/dev/null || true; }
trap cleanup EXIT
dc up -d --build --wait
docker run --rm -i --network host --entrypoint python "salafacil-backend:$IMAGE_TAG" - <<'PY'
import urllib.request
for route in ('/','/health/live','/health/ready','/api/session/csrf'):
 with urllib.request.urlopen('http://127.0.0.1:18084'+route,timeout=10) as r:
  assert r.status==200 and r.read()
print('Clean checkout setup passed: README up builds images, migrations/seed complete, HTML/health/CSRF respond through published loopback.')
PY
dc exec -T backend python manage.py migrate --noinput
dc exec -T backend python manage.py seed_local
dc exec -T backend python manage.py shell -c 'from accounts.models import User; from rooms.models import Room; assert User.objects.count()==2 and Room.objects.count()==5; print("Clean checkout fixtures verified.")'
