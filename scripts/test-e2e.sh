#!/usr/bin/env bash
set -euo pipefail
export TEST_UID="$(id -u)" TEST_GID="$(id -g)"
cd "$(dirname "$0")/.."
task_project="sf-salafacil-e2e-$(date +%s)-$$"
export IMAGE_TAG="$task_project"
export TEST_WEB_PORT="${TEST_WEB_PORT:-18081}"
mkdir -p .factory/artifacts
dc() { docker compose -p "$task_project" -f compose.yaml -f compose.test.yaml "$@"; }
cleanup() { dc logs --no-color --tail=80 backend web; dc down -v --remove-orphans >/dev/null; }
trap cleanup EXIT
dc build db init backend web e2e
dc up -d --wait web
docker run --rm --network host -e TEST_WEB_PORT --entrypoint python "salafacil-backend:$IMAGE_TAG" -c 'import os,urllib.request; r=urllib.request.urlopen("http://127.0.0.1:"+os.environ["TEST_WEB_PORT"]+"/health/ready",timeout=10); assert r.status==200; print("E2E host: published loopback port responds.")'
dc run --rm --no-deps e2e npm run typecheck
dc run --rm --no-deps e2e xvfb-run -a npx playwright test --headed
