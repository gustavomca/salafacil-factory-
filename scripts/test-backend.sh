#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
task_project="sf-salafacil-backend-$(date +%s)-$$"
export IMAGE_TAG="$task_project"
dc() { docker compose -p "$task_project" -f compose.yaml -f compose.test.yaml "$@"; }
cleanup() { dc down -v --remove-orphans >/dev/null; }
trap cleanup EXIT
dc build db backend-test
dc up -d --wait db
dc run --rm --no-deps backend-test python manage.py test --noinput --verbosity 2
dc run --rm --no-deps backend-test python manage.py makemigrations --check --dry-run
dc run --rm --no-deps backend-test ruff check --no-cache .
