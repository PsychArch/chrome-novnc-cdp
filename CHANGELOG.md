# Changelog

## v2026.11.10

- Add independent HTTP, HTTPS, SOCKS5, and SOCKS5H proxy settings to explicit
  sessions, including Basic and SOCKS5 username/password authentication and
  Chromium bypass rules.
- Keep proxy credentials out of API responses and Chromium arguments. Close
  session relays and connection pools on deletion, expiry, creation failure,
  Chromium failure, and shutdown.
- Preserve empty-body session requests and compatibility auto-sessions. Start
  Chromium at `about:blank` before loading session start URLs in their contexts.
- Serialize Chromium shutdown and startup and retry temporary profile removal
  while browser workers finish their final writes.
- Upgrade to Alpine 3.24.4 and refresh stable distribution packages. Align
  `.env.example` with noVNC 1.7.0; retain current websockify 0.13.0.
- Update and pin GitHub Actions and Caddy 2.11.9. Lock proxy-chain 3.0.3 and its
  dependencies and install them in a separate Docker build stage.
- Document the proxy API in OpenAPI and add automated local/CI integration tests.
