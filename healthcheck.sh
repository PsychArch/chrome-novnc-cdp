#!/bin/sh
set -eu

curl -fsS http://127.0.0.1:9222/json/version >/dev/null
curl -fsS http://127.0.0.1:6080/ >/dev/null
