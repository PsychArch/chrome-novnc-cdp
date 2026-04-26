#!/bin/sh
set -eu

: "${TZ:=UTC}"
: "${BROWSER_WIDTH:=${SCREEN_WIDTH:-1920}}"
: "${BROWSER_HEIGHT:=${SCREEN_HEIGHT:-1080}}"
: "${BROWSER_DEPTH:=${SCREEN_DEPTH:-24}}"
: "${BIND_HOST:=${SERVICE_BIND_HOST:-0.0.0.0}}"
: "${PUBLIC_CDP_BASE_PATH:=${CDP_BASE_PATH:-}}"
: "${CDP_PORT:=${SESSION_MANAGER_PORT:-9222}}"
: "${PRIVATE_CDP_PORT:=${CHROME_REMOTE_DEBUGGING_PORT:-9223}}"
: "${BROWSER_START_URL:=${START_URL:-about:blank}}"
: "${BROWSER_EXTRA_ARGS:=${CHROME_EXTRA_ARGS:-}}"
: "${ENABLE_HOST_GATEWAY:=${ALLOW_HOST_GATEWAY:-false}}"
: "${SESSION_IDLE_TIMEOUT:=${SESSION_IDLE_TIMEOUT_MS:-${SESSION_IDLE_TTL_MS:-1h}}}"
: "${SESSION_SWEEP_INTERVAL:=${SESSION_SWEEP_INTERVAL_MS:-15s}}"
: "${MAX_SESSIONS:=${MAX_CONCURRENT_SESSIONS:-4}}"
: "${CDP_COMPAT_AUTO_SESSION:=${COMPAT_AUTO_SESSION:-true}}"
: "${CDP_ALLOW_UNAUTHENTICATED_LOCAL:=${COMPAT_UNAUTH_LOCAL:-false}}"
: "${CDP_AUTH_TOKEN:=${API_TOKEN:-}}"
: "${CDP_ALLOW_QUERY_TOKEN:=${ALLOW_QUERY_TOKEN:-false}}"

case "${SERVICE_MODE:-sessions}" in
  sessions)
    ;;
  *)
    echo "SERVICE_MODE has been removed; managed CDP sessions are always enabled. Remove SERVICE_MODE from your environment." >&2
    exit 1
    ;;
esac

for name in BROWSER_WIDTH BROWSER_HEIGHT BROWSER_DEPTH CDP_PORT PRIVATE_CDP_PORT MAX_SESSIONS; do
  eval "value=\${${name}}"
  case "${value}" in
    ''|*[!0-9]*|0)
      echo "Invalid ${name} '${value}'. Use a positive integer." >&2
      exit 1
      ;;
  esac
done

for name in ENABLE_HOST_GATEWAY CDP_COMPAT_AUTO_SESSION CDP_ALLOW_UNAUTHENTICATED_LOCAL CDP_ALLOW_QUERY_TOKEN; do
  eval "value=\${${name}}"
  case "${value}" in
    1|0|true|false|TRUE|FALSE|yes|no|YES|NO|on|off|ON|OFF)
      ;;
    *)
      echo "Invalid ${name} '${value}'. Use true or false." >&2
      exit 1
      ;;
  esac
done

if [ ! -f "/usr/share/zoneinfo/${TZ}" ]; then
  echo "Invalid TZ '${TZ}', falling back to UTC." >&2
  TZ=UTC
fi

case "${ENABLE_HOST_GATEWAY}" in
  1|true|TRUE|yes|YES|on|ON)
    HOST_GATEWAY="$(ip route | awk '/default/ {print $3; exit}')"
    if [ -z "${HOST_GATEWAY}" ]; then
      echo "Failed to resolve host gateway IP for host.docker.internal." >&2
      exit 1
    fi
    if ! grep -q "host.docker.internal" /etc/hosts; then
      echo "${HOST_GATEWAY} host.docker.internal" >> /etc/hosts
    fi
    ;;
esac

# Export deprecated aliases too so old docker run invocations keep working while
# the runtime and docs move to user-facing names.
SCREEN_WIDTH="${BROWSER_WIDTH}"
SCREEN_HEIGHT="${BROWSER_HEIGHT}"
SCREEN_DEPTH="${BROWSER_DEPTH}"
SERVICE_BIND_HOST="${BIND_HOST}"
SESSION_MANAGER_PORT="${CDP_PORT}"
CHROME_REMOTE_DEBUGGING_PORT="${PRIVATE_CDP_PORT}"
START_URL="${BROWSER_START_URL}"
CHROME_EXTRA_ARGS="${BROWSER_EXTRA_ARGS}"
ALLOW_HOST_GATEWAY="${ENABLE_HOST_GATEWAY}"
MAX_CONCURRENT_SESSIONS="${MAX_SESSIONS}"
COMPAT_AUTO_SESSION="${CDP_COMPAT_AUTO_SESSION}"
COMPAT_UNAUTH_LOCAL="${CDP_ALLOW_UNAUTHENTICATED_LOCAL}"
API_TOKEN="${CDP_AUTH_TOKEN}"
ALLOW_QUERY_TOKEN="${CDP_ALLOW_QUERY_TOKEN}"

export TZ BROWSER_WIDTH BROWSER_HEIGHT BROWSER_DEPTH BIND_HOST CDP_PORT PRIVATE_CDP_PORT BROWSER_START_URL BROWSER_EXTRA_ARGS ENABLE_HOST_GATEWAY
export PUBLIC_CDP_BASE_PATH SESSION_IDLE_TIMEOUT SESSION_SWEEP_INTERVAL MAX_SESSIONS CDP_COMPAT_AUTO_SESSION CDP_ALLOW_UNAUTHENTICATED_LOCAL CDP_AUTH_TOKEN CDP_ALLOW_QUERY_TOKEN
export SCREEN_WIDTH SCREEN_HEIGHT SCREEN_DEPTH SERVICE_BIND_HOST SESSION_MANAGER_PORT CHROME_REMOTE_DEBUGGING_PORT START_URL CHROME_EXTRA_ARGS ALLOW_HOST_GATEWAY
export MAX_CONCURRENT_SESSIONS COMPAT_AUTO_SESSION COMPAT_UNAUTH_LOCAL API_TOKEN ALLOW_QUERY_TOKEN

ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime
echo "${TZ}" > /etc/timezone

exec supervisord -c /etc/supervisord.conf
