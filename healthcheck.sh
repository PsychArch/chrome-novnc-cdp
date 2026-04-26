#!/bin/sh
set -eu

curl -fsS "http://127.0.0.1:${CDP_PORT:-${SESSION_MANAGER_PORT:-9222}}/healthz" >/dev/null
curl -fsS http://127.0.0.1:6080/ >/dev/null
