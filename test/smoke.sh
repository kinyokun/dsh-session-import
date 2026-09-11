#!/usr/bin/env bash
# Authenticated checks; real import/undo only with SMOKE_IMPORT=1.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node test/smoke.js
