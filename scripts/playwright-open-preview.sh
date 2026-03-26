#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/playwright-open-preview.sh <preview-url> [playwright args...]" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREVIEW_URL="$1"
shift || true

export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export PWCLI="${PWCLI:-$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh}"

BYPASS_URL="$(node "$ROOT_DIR/scripts/vercel-preview-url.mjs" "$PREVIEW_URL")"

exec "$PWCLI" open "$BYPASS_URL" "$@"
