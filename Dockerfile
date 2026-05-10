FROM alpine:3.23.4

ARG NOVNC_VERSION=1.7.0
ARG NOVNC_SHA256=b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6
ARG WEBSOCKIFY_VERSION=0.13.0
ARG WEBSOCKIFY_SHA256=b6413e364efd04f3c92ec8c17747e3c4adc20157c2ef1c5d019a26d944a46df8

# Install packages
RUN apk add --no-cache \
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
RUN mkdir -p /opt/noVNC /tmp/downloads \
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
COPY entrypoint.sh /entrypoint.sh
COPY healthcheck.sh /healthcheck.sh
COPY session-manager /opt/session-manager
RUN chmod +x /entrypoint.sh
RUN chmod +x /healthcheck.sh
RUN chown -R chrome:chrome /opt/session-manager

EXPOSE 6080 9222

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 CMD ["/healthcheck.sh"]

ENTRYPOINT ["/entrypoint.sh"]
