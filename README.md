# chrome-novnc-cdp

Alpine-based Docker image that runs:

- Chromium with CDP exposed on `127.0.0.1:9222`
- noVNC web UI on `127.0.0.1:6080`
- Persistent or ephemeral Chrome profile modes

The default setup keeps services localhost-bound for safer local automation.

## Quick Start

```bash
docker compose up -d --build
```

Open:

- noVNC: `http://127.0.0.1:6080`
- CDP version endpoint: `http://127.0.0.1:9222/json/version`

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

## Build Arguments

- `NOVNC_VERSION=1.6.0`
- `NOVNC_SHA256=5066103959ef4e9b10f37e5a148627360dd8414e4cf8a7db92bdbd022e728aaa`
- `WEBSOCKIFY_VERSION=0.13.0`
- `WEBSOCKIFY_SHA256=b6413e364efd04f3c92ec8c17747e3c4adc20157c2ef1c5d019a26d944a46df8`

## Healthcheck

The image includes a Docker `HEALTHCHECK` that validates:

- CDP endpoint: `http://127.0.0.1:9222/json/version`
- noVNC endpoint: `http://127.0.0.1:6080/`

## Security Notes

- Keep `6080` and `9222` bound to localhost unless you add authentication and network restrictions.
- If you use bind mount mode, do not commit `chrome-profile/` (contains cookies/session data).
- `x11vnc` currently runs with `-nopw`; if exposing it beyond localhost, put an authenticated reverse proxy in front and restrict source IPs.

## GitHub Release Workflow

This repo includes `.github/workflows/docker.yml`:

- Pull request / branch pushes: validates compose config, builds image, and smoke-tests CDP/noVNC endpoints
- Tag pushes (`v*`): builds and publishes multi-arch images to GHCR (`ghcr.io`) and Docker Hub (`docker.io`)

Publish auth uses:
- Built-in `GITHUB_TOKEN` for GHCR
- `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` GitHub repository secrets for Docker Hub

The workflow publishes to:
- `ghcr.io/<owner>/<repo>` (lowercased)
- `docker.io/<DOCKERHUB_USERNAME>/<repo-name>` (lowercased)

## License

MIT. See `LICENSE`.

## Suggested Release Steps

```bash
git init
git add .
git commit -m "Docker: initial release"
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main

# first release tag
git tag v0.1.0
git push origin v0.1.0
```

After the first tag publish, verify package visibility in GitHub:

- Repo: public
- Package (`ghcr.io/<owner>/<repo>`): public
