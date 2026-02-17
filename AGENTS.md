# Repository Guidelines

## Project Structure & Module Organization
This repository is a Docker-first project. Core files live at the root:
- `Dockerfile`: builds the Alpine image with Chromium, noVNC, and websockify.
- `docker-compose.yml`: local orchestration, port bindings, env wiring, and volume mounts.
- `docker-compose.bind.yml`: optional override to use `./chrome-profile` bind mount instead of the default named volume.
- `entrypoint.sh`, `healthcheck.sh`, `supervisord.conf`: container startup, health checks, and process supervision.
- `.github/workflows/docker.yml`: CI validation/build and tagged release publishing.

Local runtime state is stored in the named Docker volume `chrome-profile` by default. Copy `.env.example` to `.env` for local overrides.
If you opt into bind mount mode via `docker-compose.bind.yml`, local profile data is stored in `chrome-profile/` (gitignored).

## Build, Test, and Development Commands
- `cp .env.example .env`: create local config defaults.
- `docker compose up -d --build`: build and start the stack.
- `docker compose logs -f chrome`: stream container logs.
- `docker compose down` (or `docker compose down -v`): stop services; `-v` also removes volumes.
- `docker compose config`: validate compose configuration (same check used in CI).
- `docker build --pull -t chrome-novnc-cdp:test .`: local image build check.
- `curl -fsS http://127.0.0.1:9222/json/version` and `curl -fsS http://127.0.0.1:6080/`: smoke-test CDP and noVNC endpoints.

## Coding Style & Naming Conventions
- Shell scripts should remain POSIX `sh` and start with `set -eu`.
- Match existing formatting: 2-space indentation in shell/YAML and readable line wrapping for long commands.
- Use `UPPER_SNAKE_CASE` for env vars (example: `CHROME_PROFILE_DIR`, `CHROME_EXTRA_ARGS`).
- Preserve security-focused defaults (localhost bindings, pinned download checksums).
- No formatter/linter is configured here; follow nearby style and keep edits minimal and targeted.

## Testing Guidelines
There is no unit-test framework in this repo. Treat these as required validation before opening a PR:
1. `docker compose config`
2. `docker build --pull -t chrome-novnc-cdp:test .`
3. Start the stack and verify both health endpoints return success.

For runtime or networking changes, include exact verification commands in the PR description.

## Commit & Pull Request Guidelines
This repository currently has no commit history, so use clear, scoped, imperative commit messages (example: `Docker: pin websockify SHA256`).

PRs should include:
- what changed and why,
- how it was validated,
- any env var, port, or security-impacting behavior changes,
- linked issue(s) when applicable.

Add screenshots only when noVNC UI behavior is changed.
