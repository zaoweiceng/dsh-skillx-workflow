#!/usr/bin/env bash
set -euo pipefail
DSH_EXECUTABLE="${DSH_BIN:-$(command -v dsh || true)}"
[ -n "$DSH_EXECUTABLE" ] && [ -x "$DSH_EXECUTABLE" ] || { echo 'Install DeepSeek Harness first, or set DSH_BIN.' >&2; exit 1; }
exec "$DSH_EXECUTABLE" --profile "${DSH_PROFILE:-web}" --port "${DSH_SKILLX_PORT:-3080}" "$@"
