#!/usr/bin/env bash
set -euo pipefail
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH_EXECUTABLE="${DSH_BIN:-$(command -v dsh || true)}"
[ -n "$DSH_EXECUTABLE" ] && [ -x "$DSH_EXECUTABLE" ] || { echo 'Install DeepSeek Harness first, or set DSH_BIN.' >&2; exit 1; }
exec "$DSH_EXECUTABLE" plugin --profile "${DSH_PROFILE:-web}" add "$PLUGIN_ROOT"
