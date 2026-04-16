# chrome-novnc-cdp

Run Chromium with CDP and noVNC in one container.

This README is the fast path for humans and agents who just want to run it.
For deeper runtime details, source-based workflows, and internal notes, see
[docs/operations.md](docs/operations.md).

## Official Images

Choose either registry:

- Docker Hub: `docker.io/psycharch/chrome-novnc-cdp:latest`
- GHCR: `ghcr.io/psycharch/chrome-novnc-cdp:latest`

Examples below use an `IMAGE` variable so you can swap registries easily:

```bash
IMAGE=docker.io/psycharch/chrome-novnc-cdp:latest
# or:
# IMAGE=ghcr.io/psycharch/chrome-novnc-cdp:latest
```

## Deployment Modes

### 1. Named Network Mode

Use this for normal local use. It publishes noVNC and CDP to `127.0.0.1` only.

```bash
docker pull "$IMAGE"
docker rm -f chrome-novnc-cdp >/dev/null 2>&1 || true
docker volume create chrome-profile >/dev/null
docker network inspect chrome-novnc-cdp >/dev/null 2>&1 || \
  docker network create chrome-novnc-cdp
docker run -d --name chrome-novnc-cdp \
  --restart unless-stopped \
  --network chrome-novnc-cdp \
  -p 127.0.0.1:6080:6080 \
  -p 127.0.0.1:9222:9222 \
  -v chrome-profile:/data \
  "$IMAGE"
```

Open:

- noVNC: `http://127.0.0.1:6080`
- CDP version endpoint: `http://127.0.0.1:9222/json/version`

If Chromium must reach a service running on the host, rerun with:

```bash
docker run -d --name chrome-novnc-cdp \
  --restart unless-stopped \
  --network chrome-novnc-cdp \
  -p 127.0.0.1:6080:6080 \
  -p 127.0.0.1:9222:9222 \
  -e ALLOW_HOST_GATEWAY=1 \
  -v chrome-profile:/data \
  "$IMAGE"
```

Then use `http://host.docker.internal:PORT` inside Chromium.

### 2. Host Network Mode

Use this on Linux when Chromium must reach services bound to `127.0.0.1` on the host.
In this mode, the container shares the host network namespace, so the service still
binds noVNC and CDP to `127.0.0.1` for safety.

```bash
docker pull "$IMAGE"
docker rm -f chrome-novnc-cdp >/dev/null 2>&1 || true
docker volume create chrome-profile >/dev/null
docker run -d --name chrome-novnc-cdp \
  --restart unless-stopped \
  --network host \
  -e SERVICE_BIND_HOST=127.0.0.1 \
  -v chrome-profile:/data \
  "$IMAGE"
```

Open:

- noVNC: `http://127.0.0.1:6080`
- CDP version endpoint: `http://127.0.0.1:9222/json/version`

Verify the listeners after startup:

```bash
ss -ltn '( sport = :6080 or sport = :9222 )'
```

Expected:

- `127.0.0.1:6080`
- `127.0.0.1:9222`

## Quick Checks

```bash
curl -fsS http://127.0.0.1:6080/ >/dev/null
curl -fsS http://127.0.0.1:9222/json/version
```

Stop and remove:

```bash
docker rm -f chrome-novnc-cdp
```

Remove profile data too:

```bash
docker volume rm chrome-profile
```

## Security

- Keep `6080` and `9222` bound to localhost unless you add authentication and strict network restrictions.
- Host network mode is for trusted local debugging. It is not a remote access mode.
- `ALLOW_HOST_GATEWAY=1` makes host services reachable from Chromium. Enable it only when needed.
- The browser profile may contain cookies and session data. Treat the `chrome-profile` volume as sensitive.
- If you intentionally expose this service beyond localhost, put an authenticated reverse proxy in front and restrict source IPs.

## More

- Runtime details and source-based usage: [docs/operations.md](docs/operations.md)
- License: `MIT`
