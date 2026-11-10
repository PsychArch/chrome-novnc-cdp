FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS session-dependencies

RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    apk add --no-cache nodejs npm
WORKDIR /opt/session-manager
COPY session-manager/package.json session-manager/package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --ignore-scripts --no-fund --no-audit

FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf

ARG NOVNC_VERSION=1.7.0
ARG NOVNC_SHA256=b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6
ARG WEBSOCKIFY_VERSION=0.13.0
ARG WEBSOCKIFY_SHA256=b6413e364efd04f3c92ec8c17747e3c4adc20157c2ef1c5d019a26d944a46df8

# Install packages
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    apk upgrade --no-cache && apk add --no-cache \
    xvfb \
    x11vnc \
    openbox \
    chromium \
    nodejs \
    python3 \
    supervisor \
    iproute2 \
    font-noto \
    font-noto-cjk \
    curl \
    tzdata

# Install noVNC and websockify
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export CURL_CA_BUNDLE=/run/secrets/proxy_ca; fi; \
    mkdir -p /opt/noVNC /tmp/downloads \
    && curl -fsSL "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" \
       -o /tmp/downloads/novnc.tar.gz \
    && echo "${NOVNC_SHA256}  /tmp/downloads/novnc.tar.gz" | sha256sum -c - \
    && tar xzf /tmp/downloads/novnc.tar.gz --strip-components=1 -C /opt/noVNC \
    && mkdir -p /opt/noVNC/utils/websockify \
    && curl -fsSL "https://github.com/novnc/websockify/archive/refs/tags/v${WEBSOCKIFY_VERSION}.tar.gz" \
       -o /tmp/downloads/websockify.tar.gz \
    && echo "${WEBSOCKIFY_SHA256}  /tmp/downloads/websockify.tar.gz" | sha256sum -c - \
    && tar xzf /tmp/downloads/websockify.tar.gz --strip-components=1 -C /opt/noVNC/utils/websockify \
    && ln -s /opt/noVNC/vnc.html /opt/noVNC/index.html \
    && rm -rf /tmp/downloads

# Create non-root user for Chromium and the session manager
RUN adduser -D -h /home/chrome chrome

COPY supervisord.conf /etc/supervisord.conf
COPY --chmod=755 entrypoint.sh /entrypoint.sh
COPY --chmod=755 healthcheck.sh /healthcheck.sh
COPY --chown=chrome:chrome session-manager /opt/session-manager
COPY --from=session-dependencies --chown=chrome:chrome /opt/session-manager/node_modules /opt/session-manager/node_modules

EXPOSE 6080 9222

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 CMD ["/healthcheck.sh"]

ENTRYPOINT ["/entrypoint.sh"]
