#!/usr/bin/env bash
# Run the deploy e2e spec against https://dev.badthingsforpets.com.
# Credentials: export BASIC_AUTH_* yourself, or run `pnpm secrets:sync dev`
# from infra (writes infra/cdk/.env.deploy.local).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENV_FILE="$ROOT/infra/cdk/.env.deploy.local"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
export BASE_URL="${BASE_URL:-https://dev.badthingsforpets.com}"
export BASIC_AUTH_USER="${BASIC_AUTH_USER:-${BTFP_DEV_BASIC_AUTH_USER:-}}"
export BASIC_AUTH_PASSWORD="${BASIC_AUTH_PASSWORD:-${BTFP_DEV_BASIC_AUTH_PASSWORD:-}}"
if [[ -z "$BASIC_AUTH_USER" || -z "$BASIC_AUTH_PASSWORD" ]]; then
  echo "Missing Basic Auth: set BASIC_AUTH_USER/PASSWORD or run pnpm secrets:sync dev" >&2
  exit 1
fi
cd "$ROOT/apps/e2e"
if [[ "${1:-}" == "--api-only" ]]; then
  shift
  exec pnpm exec tsx scripts/repro-contributions-api.mts "$@"
fi
exec pnpm exec playwright test "$@"
