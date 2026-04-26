# Public Reverse Proxy Example

Use this mode when noVNC or CDP must be reachable from the Internet on one
public hostname with path prefixes:

- `https://example.com/browser` -> noVNC, protected by proxy auth.
- `https://example.com/cdp` -> managed CDP, protected by `CDP_AUTH_TOKEN`.

Do not expose this service publicly without authentication. noVNC has no built-in
login gate, and CDP can control the browser.

## Caddy Sidecar

```bash
export PUBLIC_HOST=example.com
export CDP_AUTH_TOKEN='replace-with-a-long-random-token'
export NOVNC_BASIC_AUTH="$(docker run --rm caddy:2-alpine caddy hash-password --plaintext 'replace-this-password')"
docker compose up -d
```

Open noVNC through `https://$PUBLIC_HOST/browser`. Connect CDP with a bearer
token:

```bash
curl -fsS -H "Authorization: Bearer $CDP_AUTH_TOKEN" \
  https://$PUBLIC_HOST/cdp/json/version
```

## Existing Caddy Or Nginx

If your reverse proxy already runs outside this compose project, run only the
`chrome` service on a shared Docker network or publish ports to host loopback,
then adapt `Caddyfile` or `nginx.conf` to point at the service.

Required path-prefix behavior:

- Set `PUBLIC_CDP_BASE_PATH=/cdp` on the chrome service.
- Proxy `/cdp/...` to CDP on `chrome:9222`; do not strip `/cdp`.
- Proxy `/browser/...` to noVNC on `chrome:6080` after stripping `/browser`.
- Redirect `/browser` and `/browser/` to
  `/browser/vnc.html?path=browser/websockify` so noVNC opens its WebSocket under
  the same prefix.
