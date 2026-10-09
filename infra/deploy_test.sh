#!/usr/bin/env bash
# Exercises every path of deploy.sh with fake docker/curl/sleep, in a throwaway container (it needs /opt/nullify):
#   docker run --rm -v "$PWD/infra:/infra:ro" ubuntu:24.04 bash /infra/deploy_test.sh
set -euo pipefail

SHA=0123456789abcdef0123456789abcdef01234567
STUBS=$(mktemp -d)
cat > "$STUBS/curl" <<'EOF'
#!/bin/bash
while [ $# -gt 0 ]; do [ "$1" = -o ] && { echo NEW > "$2"; exit 0; }; shift; done
EOF
cat > "$STUBS/docker" <<'EOF'
#!/bin/bash
echo "docker $*" >> /tmp/docker.log
case "$*" in
  "compose pull"*)     [ "${FAIL:-}" = pull ] && exit 1 ;;
  "compose run"*)      [ "${FAIL:-}" = migrate ] && exit 1 ;;
  "compose ps -q"*)    echo backend-id ;;
  inspect*)            if [ "${FAIL:-}" = health ]; then echo unhealthy; else echo healthy; fi ;;
esac
exit 0
EOF
printf '#!/bin/sh\n' > "$STUBS/sleep"
chmod +x "$STUBS"/*

run() {   # run <FAIL> <arg>: fresh /opt/nullify at version "old", then deploy.sh; prints its exit code
  rm -rf /opt/nullify /tmp/docker.log && mkdir -p /opt/nullify
  printf 'DB_PASSWORD=x\nIMAGE_TAG=old\n' > /opt/nullify/.env
  echo OLD > /opt/nullify/docker-compose.yml
  local code=0
  FAIL="$1" PATH="$STUBS:$PATH" bash /infra/deploy.sh "$2" > /dev/null 2>&1 || code=$?
  echo "$code"
}
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2', want '$3'"; failed=1; fi; }
tag() { sed -n 's/^IMAGE_TAG=//p' /opt/nullify/.env; }
ups() { grep -c "compose up" /tmp/docker.log || true; }
failed=0

check "success exits 0"             "$(run "" $SHA)" 0
check "success records the SHA"     "$(tag)" $SHA
check "success writes the new file" "$(cat /opt/nullify/docker-compose.yml)" NEW
check "success keeps other keys"    "$(grep -c '^DB_PASSWORD=x$' /opt/nullify/.env)" 1
check "success leaves no backup"    "$(ls /opt/nullify/docker-compose.yml.prev 2>/dev/null || echo none)" none
check "success writes monitoring/"   "$(cat /opt/nullify/monitoring/prometheus/alerts.yml)" NEW
check "success reloads Prometheus"  "$(grep -c 'kill -s HUP prometheus' /tmp/docker.log)" 1

for f in pull migrate; do
  check "$f failure exits 1"          "$(run $f $SHA)" 1
  check "$f failure restores the tag" "$(tag)" old
  check "$f failure restores the file" "$(cat /opt/nullify/docker-compose.yml)" OLD
  check "$f failure never restarts"   "$(ups)" 0
  check "$f failure never reloads"    "$(grep -c 'kill' /tmp/docker.log || true)" 0
done

check "unhealthy exits 1"            "$(run health $SHA)" 1
check "unhealthy restores the tag"   "$(tag)" old
check "unhealthy restores the file"  "$(cat /opt/nullify/docker-compose.yml)" OLD
check "unhealthy restarts the old"   "$(ups)" 2

check "a short SHA is refused"       "$(run "" abc123)" 2
check "a refused SHA changes nothing" "$(tag)" old

exit $failed
