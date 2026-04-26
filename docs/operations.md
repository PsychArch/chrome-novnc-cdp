# Operations and Internals

This document keeps the lower-level notes out of the README.

## Official Images

- Docker Hub: `docker.io/psycharch/chrome-novnc-cdp:latest`
- GHCR: `ghcr.io/psycharch/chrome-novnc-cdp:latest`

## Source-Based Workflow

```bash
cp .env.example .env
docker compose up -d --build
```

Host-network mode from source:

```bash
docker compose -f docker-compose.yml -f docker-compose.host.yml up -d --build
```

## Topology Examples

The repo includes image-based examples for the three supported deployment
shapes:

- `examples/local-bridge.compose.yml`: named Docker bridge for normal local use.
  noVNC and CDP are published to host loopback only.
- `examples/local-host-network.compose.yml`: Linux host-network debugging mode.
  The runtime sets `BIND_HOST=127.0.0.1` because ports bind directly on the host.
- `examples/public-reverse-proxy/`: named Docker bridge with a path-prefix
  Caddy or nginx reverse proxy for Internet-facing access.

Use local bridge unless Chromium specifically needs access to host services that
only listen on `127.0.0.1`. Use the public reverse-proxy example only with
authentication and network restrictions.

## Release Validation

Before publishing or opening a PR, run the same source checks used by CI:

```bash
docker compose config
docker build --pull -t chrome-novnc-cdp:test .
```

## Runtime Configuration

Set these in `.env` or pass them with `docker run -e`:

- `TZ=UTC`
- `BROWSER_WIDTH=1920`
- `BROWSER_HEIGHT=1080`
- `BROWSER_DEPTH=24`
- `BROWSER_START_URL=about:blank`
- `BROWSER_EXTRA_ARGS=` for extra Chromium flags
- `BIND_HOST=0.0.0.0`; use `127.0.0.1` with host networking
- `PUBLIC_CDP_BASE_PATH=`; set to `/cdp` when public CDP is reverse-proxied
  under a path prefix
- `CDP_PORT=9222`
- `ENABLE_HOST_GATEWAY=false`; set true to map `host.docker.internal`
- `MAX_SESSIONS=4`
- `SESSION_IDLE_TIMEOUT=1h`
- `SESSION_SWEEP_INTERVAL=15s`
- `CDP_AUTH_TOKEN=`
- `CDP_COMPAT_AUTO_SESSION=true`
- `CDP_ALLOW_UNAUTHENTICATED_LOCAL=false`
- `CDP_ALLOW_QUERY_TOKEN=false`

Deprecated aliases from older images are still accepted for compatibility:

- `SCREEN_WIDTH`, `SCREEN_HEIGHT`, `SCREEN_DEPTH`
- `SERVICE_BIND_HOST`
- `START_URL`, `CHROME_EXTRA_ARGS`
- `ALLOW_HOST_GATEWAY`
- `SESSION_MANAGER_PORT`, `CHROME_REMOTE_DEBUGGING_PORT`
- `SESSION_IDLE_TIMEOUT_MS`, `SESSION_IDLE_TTL_MS`, `SESSION_SWEEP_INTERVAL_MS`
- `MAX_CONCURRENT_SESSIONS`
- `API_TOKEN`, `COMPAT_AUTO_SESSION`, `COMPAT_UNAUTH_LOCAL`, `ALLOW_QUERY_TOKEN`

`SERVICE_MODE`, `PROFILE_MODE`, `CHROME_PROFILE_DIR`, and `CHROME_USER_DATA_DIR`
are no longer part of the public runtime model. CDP is always managed by the
session manager, and browser user data is temporary. `SERVICE_MODE=sessions` is
accepted as a no-op for older scripts; any other `SERVICE_MODE` value fails fast.

## Host Access From Chromium

By default, the container does not resolve the host gateway. To let Chromium
reach host services from named-network mode, set:

```bash
ENABLE_HOST_GATEWAY=true
```

Then use `http://host.docker.internal:PORT` in Chromium.

If connectivity still fails on Linux hosts, the host firewall may be blocking
Docker bridge traffic. For example with UFW:

```bash
sudo ufw allow in on br-<docker-bridge-id>
```

Find the bridge name with:

```bash
docker network inspect chrome-novnc-cdp_default -f '{{.Id}}'
ip link | rg 'br-<id-prefix>'
```

Example:

1. Start a host service: `python -m http.server 9000`
2. Set `ENABLE_HOST_GATEWAY=true`
3. Visit `http://host.docker.internal:9000` in Chromium

## Public Reverse Proxy Notes

Public deployments should keep Chrome on a private Docker network and expose
only the reverse proxy. Avoid public `ports:` entries for `6080` or `9222`.

The bundled public example uses one hostname with path prefixes:

- Set `PUBLIC_CDP_BASE_PATH=/cdp` on the chrome service.
- Proxy `/cdp/...` to CDP on `chrome:9222`; the session manager accepts the
  prefix and reports prefixed WebSocket URLs.
- Proxy `/browser/...` to noVNC on `chrome:6080` after stripping `/browser`.
- Redirect `/browser` and `/browser/` to
  `/browser/vnc.html?path=browser/websockify` so noVNC opens its WebSocket under
  the same prefix.

The session manager uses `X-Forwarded-Proto: https` to report `wss://` CDP
WebSocket URLs, so reverse proxies should pass that header.

Public baseline:

```bash
export CDP_AUTH_TOKEN='replace-with-a-long-random-token'
export CDP_ALLOW_UNAUTHENTICATED_LOCAL=false
export CDP_ALLOW_QUERY_TOKEN=false
```

For nginx, preserve WebSocket upgrade headers and use long read/send timeouts
for CDP connections. For Caddy, `reverse_proxy` handles WebSocket upgrades by
default. See `examples/public-reverse-proxy/`.

## Health Checks

The image health check validates:

- `http://127.0.0.1:6080/`
- `http://127.0.0.1:9222/healthz`

Manual checks:

```bash
curl -fsS http://127.0.0.1:6080/ >/dev/null
curl -fsS http://127.0.0.1:9222/healthz
curl -fsS http://127.0.0.1:9222/json/version
```

## Managed Sessions

The Node manager is the only CDP frontend on `9222`. Chromium listens privately
on `127.0.0.1:9223` inside the container and starts only when a managed session
is needed. noVNC still runs on `6080`.

Session behavior:

- Each session is one Chromium `BrowserContext`.
- Sessions use a temporary browser user-data directory, not `/data`.
- Login state persistence is user-managed through client-side export/restore,
  such as Playwright `storageState`; the image does not auto-save secrets.
- Sessions expire only after relative idle time. Active WebSocket clients keep a
  session alive indefinitely.
- Capacity is fail-fast. `MAX_SESSIONS` returns `429` when full; no LRU eviction
  is performed.
- Chromium exits when the last session is deleted or idle-expired.

Default session settings:

```bash
MAX_SESSIONS=4
SESSION_IDLE_TIMEOUT=1h
SESSION_SWEEP_INTERVAL=15s
CDP_COMPAT_AUTO_SESSION=true
CDP_ALLOW_UNAUTHENTICATED_LOCAL=false
CDP_ALLOW_QUERY_TOKEN=false
```

Explicit API:

```text
GET    /healthz
GET    /readyz
POST   /sessions
GET    /sessions
GET    /sessions/:id
DELETE /sessions/:id
GET    /sessions/:id/json/version
GET    /sessions/:id/json/list
PUT    /sessions/:id/json/new?url=...
DELETE /sessions/:id/json/close/:targetId
WS     /sessions/:id/cdp
```

Compatibility API:

```text
GET    /json/version
GET    /json/list
PUT    /json/new?url=...
DELETE /json/close/:targetId
WS     /devtools/browser/compat
```

For local personal use, `CDP_AUTH_TOKEN` may be empty. If `9222` is reachable
beyond localhost, set `CDP_AUTH_TOKEN`, keep the port behind network
restrictions, and keep `CDP_ALLOW_UNAUTHENTICATED_LOCAL=false` so compatibility
endpoints require a bearer token. Keep `CDP_ALLOW_QUERY_TOKEN=false` unless a
client cannot send headers; query tokens can leak through logs, shell history,
and reverse-proxy request records.

`CDP_ALLOW_UNAUTHENTICATED_LOCAL=true` only skips bearer auth for requests the
server considers local. A request is local when `BIND_HOST` is a loopback
address (kernel-enforced) or when the peer address is `127.0.0.1`/`::1`. In
bridge networking with `-p 127.0.0.1:9222:9222`, Docker may rewrite the peer
to the bridge gateway IP, so prefer host networking (`--network host` with
`BIND_HOST=127.0.0.1`) when relying on this flag, or simply set
`CDP_AUTH_TOKEN`.

Playwright notes:

- `chromium.connectOverCDP("http://127.0.0.1:9222")` uses the compatibility
  endpoint and lazily creates one session.
- With `CDP_AUTH_TOKEN` set, use `connectOverCDP(url, { headers: { Authorization:
  "Bearer ..." } })`.
- Use the existing context returned by CDP. `Target.createBrowserContext` is
  blocked because one managed BrowserContext equals one managed session.
- A CDP `Browser.close` command deletes the corresponding session instead of
  closing the whole service. If a client only disconnects, the session remains
  until explicit deletion or idle expiry.

## Internal Runtime Notes

- Named-network mode publishes ports to `127.0.0.1`.
- Host-network mode relies on `BIND_HOST=127.0.0.1` so noVNC and CDP do not bind to all host interfaces.
- The session manager proxies CDP on `9222` and scopes traffic to each managed `BrowserContext`: `Browser.close`, `Browser.crash`, `Browser.crashGpuProcess`, `Target.createBrowserContext`, `Target.attachToBrowserTarget`, and any command whose `browserContextId` names another session are rejected. Chromium still runs with `--no-sandbox`, so treat the service as trusted single-tenant tooling.
- Raw Chromium DevTools listens only on private `127.0.0.1:9223` inside the container.
- Raw VNC remains loopback-only inside the runtime.
- Chromium currently runs with `--no-sandbox` for compatibility inside this container, so treat it as trusted local tooling rather than a hardened multi-tenant browser service.
