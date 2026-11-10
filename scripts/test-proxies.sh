#!/bin/sh
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
image="${1:-chrome-novnc-cdp:test}"
container="chrome-novnc-cdp-proxy-test-$$"

cleanup() {
  status=$?
  trap - 0
  if [ "$status" -ne 0 ]; then docker logs "$container" >&2 || true; fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM

# The fixture CA and browser certificate override are test-only. Production
# upstream TLS verification stays enabled and the fixture key is not in the image.
docker run -d --name "$container" --shm-size=2g \
  --mount "type=bind,src=${repo_dir}/session-manager/test,dst=/opt/session-manager/test,readonly" \
  -e NODE_EXTRA_CA_CERTS=/opt/session-manager/test/fixtures/ca.pem \
  -e BROWSER_EXTRA_ARGS=--ignore-certificate-errors \
  -e BROWSER_START_URL=http://startup-probe.invalid/ \
  -e SESSION_IDLE_TIMEOUT=3s -e SESSION_SWEEP_INTERVAL=250ms \
  -e MAX_SESSIONS=4 "$image" >/dev/null

docker exec "$container" sh -c '
  for i in $(seq 1 30); do
    if /healthcheck.sh >/dev/null 2>&1; then exit 0; fi
    sleep 1
  done
  exit 1
'
docker exec -e MANAGED_CDP_TEST_URL=http://127.0.0.1:9222 "$container" \
  node --test /opt/session-manager/test/options.test.mjs /opt/session-manager/test/integration.test.mjs

docker rm -f "$container" >/dev/null
docker run -d --name "$container" --shm-size=2g \
  --mount "type=bind,src=${repo_dir}/session-manager/test,dst=/opt/session-manager/test,readonly" \
  -e NODE_OPTIONS=--import=/opt/session-manager/test/inject-target-failure.mjs \
  -e MAX_SESSIONS=1 "$image" >/dev/null
docker exec "$container" sh -c '
  for i in $(seq 1 30); do
    if /healthcheck.sh >/dev/null 2>&1; then exit 0; fi
    sleep 1
  done
  exit 1
'
docker exec -e MANAGED_CDP_ROLLBACK_URL=http://127.0.0.1:9222 "$container" \
  node --test /opt/session-manager/test/rollback.test.mjs
