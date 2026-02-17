#!/bin/sh
set -eu

: "${SCREEN_WIDTH:=1920}"
: "${SCREEN_HEIGHT:=1080}"
: "${SCREEN_DEPTH:=24}"
: "${TZ:=UTC}"
: "${PROFILE_MODE:=persistent}"
: "${CHROME_PROFILE_DIR:=Default}"
: "${CHROME_EXTRA_ARGS:=}"
: "${START_URL:=about:blank}"

case "${PROFILE_MODE}" in
  persistent|ephemeral)
    ;;
  *)
    echo "Invalid PROFILE_MODE '${PROFILE_MODE}'. Use 'persistent' or 'ephemeral'." >&2
    exit 1
    ;;
esac

if [ -z "${CHROME_USER_DATA_DIR+x}" ]; then
  if [ "${PROFILE_MODE}" = "ephemeral" ]; then
    CHROME_USER_DATA_DIR=/tmp/chrome-data
  else
    CHROME_USER_DATA_DIR=/data
  fi
fi

if [ ! -f "/usr/share/zoneinfo/${TZ}" ]; then
  echo "Invalid TZ '${TZ}', falling back to UTC." >&2
  TZ=UTC
fi

export SCREEN_WIDTH SCREEN_HEIGHT SCREEN_DEPTH TZ PROFILE_MODE CHROME_PROFILE_DIR CHROME_EXTRA_ARGS START_URL CHROME_USER_DATA_DIR

ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime
echo "${TZ}" > /etc/timezone

mkdir -p "${CHROME_USER_DATA_DIR}"
chown -R chrome:chrome "${CHROME_USER_DATA_DIR}"
rm -f "${CHROME_USER_DATA_DIR}/SingletonLock" "${CHROME_USER_DATA_DIR}/SingletonSocket" "${CHROME_USER_DATA_DIR}/SingletonCookie"

exec supervisord -c /etc/supervisord.conf
