# chrome-novnc-cdp

Run managed Chromium CDP sessions with noVNC in one container.

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

## Quick Start

Use this for normal local use. It publishes noVNC and managed CDP to
`127.0.0.1` only.

```bash
docker pull "$IMAGE"
docker rm -f chrome-novnc-cdp >/dev/null 2>&1 || true
docker network inspect chrome-novnc-cdp >/dev/null 2>&1 || \
  docker network create chrome-novnc-cdp
docker run -d --name chrome-novnc-cdp \
  --restart unless-stopped \
  --network chrome-novnc-cdp \
  -p 127.0.0.1:6080:6080 \
  -p 127.0.0.1:9222:9222 \
  "$IMAGE"
```

Open:

- noVNC: `http://127.0.0.1:6080`
- CDP version endpoint: `http://127.0.0.1:9222/json/version`

Quick checks:

```bash
curl -fsS http://127.0.0.1:6080/ >/dev/null
curl -fsS http://127.0.0.1:9222/json/version
```

## Deployment Topologies

Use the example that matches the network boundary you want:

| Use case | Example | Why |
| --- | --- | --- |
| Local named bridge | `examples/local-bridge.compose.yml` | Safe default for personal use; ports are bound to `127.0.0.1`. |
| Local host network | `examples/local-host-network.compose.yml` | Linux debugging mode when Chromium must reach host services bound to `127.0.0.1`. |
| Public reverse proxy | `examples/public-reverse-proxy/` | Internet-facing mode with a proxy in front of noVNC and bearer auth on CDP. |

Run an image-based example with:

```bash
docker compose -f examples/local-bridge.compose.yml up -d
```

For source-based development, keep using the root `docker-compose.yml`; it is
the local named-bridge setup used by CI validation.

## Browser Automation

The CDP endpoint on `9222` is managed by the Node session manager. Chromium
itself listens only on a private loopback port inside the container and starts
lazily when a session is needed.

`chromium.connectOverCDP("http://127.0.0.1:9222")` works without a prior API
call. The compatibility WebSocket at `/devtools/browser/compat` lazily creates
one managed session when capacity is available.

Explicit session API examples:

```bash
curl -fsS http://127.0.0.1:9222/openapi.json
curl -fsS -X POST http://127.0.0.1:9222/sessions
curl -fsS http://127.0.0.1:9222/sessions
curl -fsS http://127.0.0.1:9222/json/version
```

The OpenAPI spec documents the managed API on `9222`. WebSocket payloads use
the Chrome DevTools Protocol.

Each managed session is one Chromium `BrowserContext`. Use the returned existing
context from CDP clients; creating extra browser contexts is intentionally
blocked so capacity maps to `MAX_SESSIONS`.

Sessions use temporary browser data. The image does not automatically persist
cookies, localStorage, or IndexedDB to `/data`; export and restore client-side
state yourself, such as Playwright `storageState`, when you need persistence.

## Configuration

Common runtime settings:

```bash
-e BROWSER_WIDTH=1920
-e BROWSER_HEIGHT=1080
-e BROWSER_START_URL=about:blank
-e MAX_SESSIONS=4
-e SESSION_IDLE_TIMEOUT=1h
-e CDP_AUTH_TOKEN=replace-with-a-long-random-token
```

If Chromium must reach a service running on the host in named-network mode,
rerun with:

```bash
docker run -d --name chrome-novnc-cdp \
  --restart unless-stopped \
  --network chrome-novnc-cdp \
  -p 127.0.0.1:6080:6080 \
  -p 127.0.0.1:9222:9222 \
  -e ENABLE_HOST_GATEWAY=true \
  "$IMAGE"
```

Then use `http://host.docker.internal:PORT` inside Chromium.

When `CDP_AUTH_TOKEN` is set, pass it as a bearer token:

```bash
curl -fsS -H "Authorization: Bearer $CDP_AUTH_TOKEN" \
  -X POST http://127.0.0.1:9222/sessions
```

## Host Network Mode

Use this on Linux when Chromium must reach services bound to `127.0.0.1` on the
host. In this mode, the container shares the host network namespace, so bind the
service to `127.0.0.1` for safety.

```bash
docker pull "$IMAGE"
docker rm -f chrome-novnc-cdp >/dev/null 2>&1 || true
docker run -d --name chrome-novnc-cdp \
  --restart unless-stopped \
  --network host \
  -e BIND_HOST=127.0.0.1 \
  "$IMAGE"
```

Verify the listeners after startup:

```bash
ss -ltn '( sport = :6080 or sport = :9222 )'
```

Expected:

- `127.0.0.1:6080`
- `127.0.0.1:9222`

The same mode is available as an image-based compose example:

```bash
docker compose -f examples/local-host-network.compose.yml up -d
```

## Public Reverse Proxy

Use named bridge networking plus Caddy or nginx when the service must be
reachable from the Internet. Do not use host networking for public access.

The public example keeps Chrome on a private Docker network and publishes only
the reverse proxy. It uses one public hostname with path prefixes:

```bash
cd examples/public-reverse-proxy
export PUBLIC_HOST=example.com
export CDP_AUTH_TOKEN='replace-with-a-long-random-token'
export NOVNC_BASIC_AUTH="$(docker run --rm caddy:2-alpine caddy hash-password --plaintext 'replace-this-password')"
docker compose up -d
```

- `https://example.com/browser` for noVNC, protected by proxy auth.
- `https://example.com/cdp` for CDP with `PUBLIC_CDP_BASE_PATH=/cdp`.

See `examples/public-reverse-proxy/README.md` for Caddy and nginx templates.

## Security

- Keep `6080` and `9222` bound to localhost unless you add authentication and strict network restrictions.
- For exposed deployments, set `CDP_AUTH_TOKEN`, keep `CDP_ALLOW_UNAUTHENTICATED_LOCAL=false`, and keep `CDP_ALLOW_QUERY_TOKEN=false`.
- Host network mode is for trusted local debugging. It is not a remote access mode.
- `ENABLE_HOST_GATEWAY=true` makes host services reachable from Chromium. Enable it only when needed.
- Session data is temporary by default, but pages can still handle sensitive data while a session is alive.
- If you intentionally expose this service beyond localhost, put an authenticated reverse proxy in front and restrict source IPs.
- The session manager scopes CDP traffic to each managed `BrowserContext` (blocks `Browser.close`, `Browser.crash*`, `Target.createBrowserContext`, `Target.attachToBrowserTarget`, and any command whose `browserContextId` is not the caller's). Chromium still runs with `--no-sandbox`, so treat the service as trusted single-tenant tooling rather than a hardened multi-tenant browser service.
- `CDP_ALLOW_UNAUTHENTICATED_LOCAL=true` only skips bearer auth for connections the server considers local. A connection is treated as local when `BIND_HOST` is a loopback address (the kernel enforces locality) or when the peer address is `127.0.0.1`/`::1`. In bridge-networking mode with `-p 127.0.0.1:9222:9222`, Docker may rewrite the source to the bridge gateway, so prefer host networking (or just set `CDP_AUTH_TOKEN`) when relying on this flag.

## Stop

```bash
docker rm -f chrome-novnc-cdp
```

## More

- Runtime details and source-based usage: [docs/operations.md](docs/operations.md)
- License: `MIT`
