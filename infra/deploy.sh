#!/usr/bin/env bash
# Deploy one commit to this box: its docker-compose.yml and the images tagged with its SHA.
# CI runs it as root through SSM (.github/workflows/deploy.yml). By hand: sudo bash deploy.sh <40-character sha>
# A failed pull, migration or health check puts the previous compose file and IMAGE_TAG back. A migration that
# already ran is NOT undone, so roll back only to a commit whose code works with the newer schema.
set -euo pipefail

SHA="${1:-}"
REPO="Aswin-Shine/Nullify-Incident-Management-System"
cd /opt/nullify
export HOME="${HOME:-/root}"   # SSM runs without one; the docker CLI wants it

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: deploy.sh <40-character commit sha>" >&2; exit 2; }
[ -f .env ] || { echo "/opt/nullify/.env is missing: copy the server env file first (infra/README.md)" >&2; exit 1; }

prev_tag=$(sed -n 's/^IMAGE_TAG=//p' .env | tail -n 1)
[ -f docker-compose.yml ] && cp docker-compose.yml docker-compose.yml.prev

set_tag() {
  sed -i '/^IMAGE_TAG=/d' .env
  if [ -n "$1" ]; then echo "IMAGE_TAG=$1" >> .env; fi
  chown --reference=. .env docker-compose.yml   # keep both editable by the directory's owner (ubuntu)
}

rollback() {
  echo "!! $1: going back to ${prev_tag:-v1}" >&2
  if [ -f docker-compose.yml.prev ]; then mv docker-compose.yml.prev docker-compose.yml; fi
  set_tag "$prev_tag"
}

echo "== Deploying $SHA (was ${prev_tag:-v1})"
# The files the monitoring profile mounts, so Prometheus and Grafana have their config from the first deploy.
# ponytail: not rolled back with the compose file (they only change scrape targets, alerts and dashboards);
# a file added under monitoring/ must be listed here (test_deploy_config.py checks).
for f in monitoring/prometheus/prometheus.yml monitoring/prometheus/alerts.yml \
         monitoring/grafana/provisioning/datasources/prometheus.yml \
         monitoring/grafana/provisioning/dashboards/nullify.yml \
         monitoring/grafana/dashboards/nullify-overview.json; do
  mkdir -p "$(dirname "$f")"
  curl -fsSL "https://raw.githubusercontent.com/$REPO/$SHA/$f" -o "$f.new"
  mv "$f.new" "$f"
done
chown -R --reference=. monitoring

curl -fsSL "https://raw.githubusercontent.com/$REPO/$SHA/docker-compose.yml" -o docker-compose.yml.new
mv docker-compose.yml.new docker-compose.yml
set_tag "$SHA"

# Nothing running has changed yet, so these two only need the files put back.
docker compose pull --quiet || { rollback "image pull failed"; exit 1; }
docker compose run --rm migrate || { rollback "migration failed"; exit 1; }

docker compose up -d --no-build

echo "== Waiting for the backend healthcheck"
status=starting
for _ in $(seq 1 24); do
  sleep 5
  status=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q backend | head -n 1)" 2>/dev/null || echo starting)
  [ "$status" = healthy ] && break
done
if [ "$status" != healthy ]; then
  rollback "backend is $status after 2 minutes"
  docker compose up -d --no-build
  exit 1
fi

rm -f docker-compose.yml.prev
# Prometheus reads its config and rules only at start or on SIGHUP; Grafana re-reads dashboards by itself.
if [ -n "$(docker compose ps -q prometheus 2>/dev/null)" ]; then docker compose kill -s HUP prometheus; fi
docker image prune -af --filter until=168h >/dev/null   # unused images older than a week; recent ones stay for rollbacks
docker compose ps
echo "== Deployed $SHA"
