# chrome-novnc-cdp

Run Chromium with CDP and noVNC in one container.

## Quick Start (Docker Hub)

```bash
docker pull docker.io/psycharch/chrome-novnc-cdp:latest
docker run --rm -d --name chrome-novnc-cdp \
  -p 127.0.0.1:6080:6080 \
  -p 127.0.0.1:9222:9222 \
  docker.io/psycharch/chrome-novnc-cdp:latest
```

Open:

- noVNC: `http://127.0.0.1:6080`
- CDP version endpoint: `http://127.0.0.1:9222/json/version`

Stop:

```bash
docker rm -f chrome-novnc-cdp
```

## Quick Start (From Source)

```bash
cp .env.example .env
docker compose up -d --build
```

## Runtime Configuration

Set these in `.env` (see `.env.example`) or export them in your shell.

- `TZ=UTC`
- `SCREEN_WIDTH=1920`
- `SCREEN_HEIGHT=1080`
- `SCREEN_DEPTH=24`
- `PROFILE_MODE=persistent` (`ephemeral` uses `/tmp/chrome-data`)
- `CHROME_USER_DATA_DIR` (optional explicit override)
- `CHROME_PROFILE_DIR=Default`
- `START_URL=about:blank`
- `CHROME_EXTRA_ARGS=`
- `ALLOW_HOST_GATEWAY=` (set to `1` or `true` to map `host.docker.internal`)

## Profile Storage

Default persistence uses a named Docker volume:

- Volume: `chrome-profile`
- Mount point in container: `/data`
- Reset profile data: `docker compose down -v`

Optional bind mount mode is available via override file:

```bash
mkdir -p chrome-profile
docker compose -f docker-compose.yml -f docker-compose.bind.yml up -d --build
```

## Host Access From Chrome

By default, the container cannot resolve the host gateway. To allow Chromium to reach host ports,
set `ALLOW_HOST_GATEWAY=1` (or `true`) and use `http://host.docker.internal:PORT`.
This makes host services reachable from inside the container; use it only when needed.

If connectivity still fails on Linux hosts, a firewall rule may be blocking Docker bridge traffic.
For example with UFW you can allow the Docker bridge interface:

```bash
sudo ufw allow in on br-<docker-bridge-id>
```

You can find the bridge name via:

```bash
docker network inspect chrome-novnc-cdp_default -f '{{.Id}}'
ip link | rg 'br-<id-prefix>'
```

Example:

1. Start a host service: `python -m http.server 9000`
2. Set `ALLOW_HOST_GATEWAY=1` in `.env`
3. Visit `http://host.docker.internal:9000` in Chromium

## Healthcheck

The image includes a Docker `HEALTHCHECK` that validates:

- CDP endpoint: `http://127.0.0.1:9222/json/version`
- noVNC endpoint: `http://127.0.0.1:6080/`

## Security Notes

- Keep `6080` and `9222` bound to localhost unless you add authentication and network restrictions.
- If you use bind mount mode, do not commit `chrome-profile/` (contains cookies/session data).
- `x11vnc` currently runs with `-nopw`; if exposing it beyond localhost, put an authenticated reverse proxy in front and restrict source IPs.

## License

MIT. See `LICENSE`.
