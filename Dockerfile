FROM alpine:3.23

ARG NOVNC_VERSION=1.6.0
ARG NOVNC_SHA256=5066103959ef4e9b10f37e5a148627360dd8414e4cf8a7db92bdbd022e728aaa
ARG WEBSOCKIFY_VERSION=0.13.0
ARG WEBSOCKIFY_SHA256=b6413e364efd04f3c92ec8c17747e3c4adc20157c2ef1c5d019a26d944a46df8

# Install packages
RUN apk add --no-cache \
    xorg-server \
    xvfb-run \
    x11vnc \
    openbox \
    chromium \
    socat \
    supervisor \
    py3-numpy \
    font-noto \
    font-noto-cjk \
    bash \
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

# Create non-root user and profile directory
RUN adduser -D -h /home/chrome chrome \
    && mkdir -p /data \
    && chown chrome:chrome /data

COPY supervisord.conf /etc/supervisord.conf
COPY entrypoint.sh /entrypoint.sh
COPY healthcheck.sh /healthcheck.sh
RUN chmod +x /entrypoint.sh
RUN chmod +x /healthcheck.sh

EXPOSE 6080 9222

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 CMD ["/healthcheck.sh"]

ENTRYPOINT ["/entrypoint.sh"]
