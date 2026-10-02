#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/test-backend.sh
bash scripts/test-frontend.sh
bash scripts/test-e2e.sh
bash scripts/test-operations.sh
