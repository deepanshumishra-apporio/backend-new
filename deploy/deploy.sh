#!/usr/bin/env bash
# Runs ON the production server. The deploy job pipes it over SSH:
#
#   ssh deploy@host "bash -s -- ghcr.io/owner/repo:<sha>" < deploy/deploy.sh
#
# 1. pull the image
# 2. run `prisma migrate deploy` from that image (a failure stops here, with the
#    old container still serving)
# 3. stop the old container, start the new one
# 4. wait for its HEALTHCHECK; if it never turns healthy, restart the old one
#
# There is a few seconds' gap between 3 and 4. Running two containers side by
# side would mean two copies of every background loop and a port juggle; for
# one server the short gap is the simpler trade.
set -euo pipefail

IMAGE="${1:?usage: deploy.sh <image:tag>}"
APP_DIR="${APP_DIR:-/opt/backend}"
ENV_FILE="$APP_DIR/.env"
NAME="backend"
# Per-server overrides (BIND_ADDRESS, HOST_PORT) live on the server, not in CI.
# shellcheck disable=SC1091
[[ -r "$APP_DIR/deploy.conf" ]] && source "$APP_DIR/deploy.conf"
# Localhost by default: TLS terminates at a reverse proxy in front. A server
# with no proxy yet sets BIND_ADDRESS=0.0.0.0 in deploy.conf.
BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"
HOST_PORT="${HOST_PORT:-3000}"
HEALTH_WAIT_SECONDS=120

log() { printf '[deploy] %s\n' "$*"; }

if [[ ! -r "$ENV_FILE" ]]; then
  log "missing $ENV_FILE — see deploy/README.md"
  exit 1
fi

log "pulling $IMAGE"
docker pull --quiet "$IMAGE"

# Migrations run once, before any new code serves traffic. They must be
# backward compatible with the code still running (add, backfill, then remove
# in a later release) because the old container keeps serving during this step.
log "applying migrations"
docker run --rm --env-file "$ENV_FILE" "$IMAGE" bunx --bun prisma migrate deploy

docker rm -f "$NAME-previous" >/dev/null 2>&1 || true
if docker container inspect "$NAME" >/dev/null 2>&1; then
  log "stopping current container"
  # index.ts drains requests and background ticks in up to 10s.
  docker stop -t 20 "$NAME" >/dev/null
  docker rename "$NAME" "$NAME-previous"
fi

log "starting $IMAGE"
docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -e PORT=3000 \
  -p "$BIND_ADDRESS:$HOST_PORT:3000" \
  --stop-timeout 20 \
  --log-opt max-size=50m --log-opt max-file=5 \
  "$IMAGE" >/dev/null

deadline=$((SECONDS + HEALTH_WAIT_SECONDS))
health="starting"
while (( SECONDS < deadline )); do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo missing)"
  [[ "$health" == "healthy" ]] && break
  if [[ "$(docker inspect --format '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]]; then
    health="exited"
    break
  fi
  sleep 3
done

if [[ "$health" != "healthy" ]]; then
  log "new container is $health — last log lines:"
  docker logs --tail 80 "$NAME" 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if docker container inspect "$NAME-previous" >/dev/null 2>&1; then
    log "restoring previous container"
    docker rename "$NAME-previous" "$NAME"
    docker start "$NAME" >/dev/null
  fi
  exit 1
fi

log "healthy"
docker rm "$NAME-previous" >/dev/null 2>&1 || true
# Keep a week of images on disk so a recent rollback needs no pull.
docker image prune -af --filter "until=168h" >/dev/null || true
log "done: $IMAGE"
