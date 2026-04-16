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

Bind-mounted profile mode from source:

```bash
mkdir -p chrome-profile
docker compose -f docker-compose.yml -f docker-compose.bind.yml up -d --build
```

Host-network mode with bind-mounted profile:

```bash
docker compose -f docker-compose.yml \
  -f docker-compose.bind.yml \
  -f docker-compose.host.yml \
  up -d --build
```

## Runtime Configuration

Set these in `.env` or pass them with `docker run -e`:

- `TZ=UTC`
- `SCREEN_WIDTH=1920`
- `SCREEN_HEIGHT=1080`
- `SCREEN_DEPTH=24`
- `SERVICE_BIND_HOST=0.0.0.0`
- `PROFILE_MODE=persistent`
- `CHROME_USER_DATA_DIR` for an explicit user-data path
- `CHROME_PROFILE_DIR=Default`
- `START_URL=about:blank`
- `CHROME_EXTRA_ARGS=`
- `ALLOW_HOST_GATEWAY=` set to `1` or `true` to map `host.docker.internal`

`docker-compose.host.yml` overrides `SERVICE_BIND_HOST` to `127.0.0.1` so host-network mode remains loopback-only.

## Profile Storage

Default persistence uses a named Docker volume:

- Volume: `chrome-profile`
- Mount point: `/data`

To reset profile data in compose mode:

```bash
docker compose down -v
```

If you use bind-mounted profile mode, `chrome-profile/` contains sensitive browser state and should stay uncommitted.

## Host Access From Chromium

By default, the container does not resolve the host gateway. To let Chromium reach host services from named-network mode, set:

```bash
ALLOW_HOST_GATEWAY=1
```

Then use `http://host.docker.internal:PORT` in Chromium.

If connectivity still fails on Linux hosts, the host firewall may be blocking Docker bridge traffic. For example with UFW:

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
2. Set `ALLOW_HOST_GATEWAY=1`
3. Visit `http://host.docker.internal:9000` in Chromium

## Health Checks

The image health check validates:

- `http://127.0.0.1:6080/`
- `http://127.0.0.1:9222/json/version`

Manual checks:

```bash
curl -fsS http://127.0.0.1:6080/ >/dev/null
curl -fsS http://127.0.0.1:9222/json/version
```

## Internal Runtime Notes

- Named-network mode publishes ports to `127.0.0.1`.
- Host-network mode relies on `SERVICE_BIND_HOST=127.0.0.1` so noVNC and CDP do not bind to all host interfaces.
- Chromium itself listens for DevTools on `127.0.0.1:9223`, and a local proxy exposes `9222`.
- Raw VNC remains loopback-only inside the runtime.
- Chromium currently runs with `--no-sandbox` for compatibility inside this container, so treat it as trusted local tooling rather than a hardened multi-tenant browser service.
