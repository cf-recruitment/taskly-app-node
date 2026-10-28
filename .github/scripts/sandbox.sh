#!/usr/bin/env bash
# Run npm tasks for one package in a keyless container. Usage:
#   sandbox.sh <install|test|typecheck> <backend|frontend> [vitest args]
# The container gets no host environment, so the model key is never inside.
# install needs the registry; test and typecheck run with no network.
set -euo pipefail

IMAGE="node:24@sha256:e2007d1f4e652444f88d9bb196256d2d035269015e3d27a0d47c1d0cb5192a98"

action="${1:-}"
package="${2:-}"
[[ "$action" =~ ^(install|test|typecheck)$ && "$package" =~ ^(backend|frontend)$ ]] || {
  echo "usage: sandbox.sh <install|test|typecheck> <backend|frontend> [args]" >&2
  exit 64
}
shift 2

# Mount the repo root wherever the script is called from.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cache="${SANDBOX_NPM_CACHE:-${HOME:?HOME is not set}/.cache/test-agent-npm}"
mkdir -p "$cache"

network=none
case "$action" in
  install)   network=bridge; cmd=(npm ci) ;;
  test)      cmd=(node_modules/.bin/vitest run "$@") ;;
  typecheck) cmd=(node_modules/.bin/tsc --noEmit "$@") ;;
esac

# HOME is a writable dir so a non-root uid can run npm and prisma.
exec docker run --rm \
  --user "$(id -u):$(id -g)" \
  --network="$network" \
  -e HOME=/tmp -e npm_config_cache=/npm-cache -e CI=true \
  -v "$root":/w -v "$cache":/npm-cache \
  -w "/w/$package" \
  "$IMAGE" "${cmd[@]}"
