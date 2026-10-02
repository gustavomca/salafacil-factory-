#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
task_project="sf-salafacil-frontend-$(date +%s)-$$"
export IMAGE_TAG="$task_project"
dc() { docker compose -p "$task_project" -f compose.yaml -f compose.test.yaml "$@"; }
cleanup() { dc down -v --remove-orphans >/dev/null || true; }
trap cleanup EXIT
dc build frontend-test
dc run --rm --no-deps frontend-test sh -c 'npm run lint && npm run typecheck && npm run test && npm run build'
