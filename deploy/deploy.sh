#!/bin/sh
# Builds and starts one environment ON THE SERVER, from an unpacked source tree (push.sh sends it).
#   deploy/deploy.sh staging
# Reads /srv/iorder/<env>/deploy.env (API_PORT, DB_NAME, APP_ROLE, public VITE_ values) and
# /srv/iorder/<env>/migrator.env (DATABASE_URL of the owner, used only for migrations and grants).
set -eu

ENV_NAME="${1:?usage: deploy.sh staging|prod}"
case "$ENV_NAME" in staging | prod) ;; *) echo "unknown environment: $ENV_NAME" >&2; exit 1 ;; esac

SRC="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="/srv/iorder/$ENV_NAME"
# shellcheck disable=SC1091
. "$HOME_DIR/deploy.env"
: "${API_PORT:?}" "${DB_NAME:?}" "${APP_ROLE:?}"

# The server is shared with other sites: builds get two CPUs at most, at low priority. Its kernel
# has no memory cgroup, so memory is capped inside the image instead (NODE_OPTIONS in Dockerfile).
build() {
  nice -n 10 docker build --cpu-period 100000 --cpu-quota 200000 -f "$SRC/deploy/Dockerfile" "$@" "$SRC"
}

echo "== media folder"
# First, so a failure stops the deploy before anything changes. Product photos live on the host
# (compose.app.yml mounts it into the api as /srv/media). The api runs as `node` (uid 1000)
# without capabilities, so the folder must belong to that uid.
mkdir -p "$HOME_DIR/media"
if [ "$(stat -c %u "$HOME_DIR/media")" != "1000" ]; then
  sudo -n chown 1000:1000 "$HOME_DIR/media" || {
    echo "cannot give $HOME_DIR/media to uid 1000; run: sudo chown 1000:1000 $HOME_DIR/media" >&2
    exit 1
  }
fi

echo "== build api image"
build --target api -t "iorder-api:$ENV_NAME" -t "iorder-api:$ENV_NAME-$(date +%Y%m%d%H%M)"

echo "== build web"
build --target web -t "iorder-web:$ENV_NAME" \
  --build-arg "VITE_TELEGRAM_BOT_USERNAME=${VITE_TELEGRAM_BOT_USERNAME:-}" \
  --build-arg "VITE_TELEGRAM_BOT_URL=${VITE_TELEGRAM_BOT_URL:-}" \
  --build-arg "VITE_STAFF_TELEGRAM_BOT_USERNAME=${VITE_STAFF_TELEGRAM_BOT_USERNAME:-}"

echo "== migrate $DB_NAME"
docker run --rm --network iorder --env-file "$HOME_DIR/migrator.env" -w /app/apps/api \
  "iorder-api:$ENV_NAME" node_modules/.bin/prisma migrate deploy
# The app role owns nothing; re-applied after every migration (production-db-roles.md, step 2).
docker exec -i iorder-postgres psql -U iorder_owner -d "$DB_NAME" -v ON_ERROR_STOP=1 -q \
  -v app_role="$APP_ROLE" <"$SRC/apps/api/db/app-role-grants.sql"

echo "== publish web"
CID="$(docker create "iorder-web:$ENV_NAME")"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
for APP in staff customer; do
  rm -rf "$HOME_DIR/www/$APP.new"
  docker cp "$CID:/app/apps/$APP/dist" "$HOME_DIR/www/$APP.new"
  chmod -R a+rX "$HOME_DIR/www/$APP.new"
  # Swap the directories, so Apache never serves a half-copied app.
  rm -rf "$HOME_DIR/www/$APP.old"
  if [ -d "$HOME_DIR/www/$APP" ]; then mv "$HOME_DIR/www/$APP" "$HOME_DIR/www/$APP.old"; fi
  mv "$HOME_DIR/www/$APP.new" "$HOME_DIR/www/$APP"
done

echo "== restart api"
IORDER_ENV="$ENV_NAME" API_PORT="$API_PORT" docker compose -f "$SRC/deploy/compose.app.yml" up -d api

echo "== restart worker (only when it already runs)"
# The worker is switched on by hand (jobs stay off until the owner decides), so a deploy never
# starts it. But a running worker must get the new image and api.env too: it runs the outbox,
# the price posts and the sheet sync, and an old one kept running the previous release.
if [ -n "$(docker ps -q --filter "name=^iorder-$ENV_NAME-worker-1\$")" ]; then
  IORDER_ENV="$ENV_NAME" API_PORT="$API_PORT" docker compose -f "$SRC/deploy/compose.app.yml" \
    --profile worker up -d worker
else
  echo "worker is not running; left off"
fi

echo "== wait for the api on 127.0.0.1:$API_PORT"
for _ in $(seq 1 30); do
  if wget -q -O /dev/null "http://127.0.0.1:$API_PORT/health" 2>/dev/null || curl -fsS -o /dev/null "http://127.0.0.1:$API_PORT/health" 2>/dev/null; then
    echo "api is up"
    exit 0
  fi
  sleep 2
done
echo "api did not answer /health; see: docker logs iorder-$ENV_NAME-api-1" >&2
exit 1
