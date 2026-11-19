FROM node:22-slim

# Borrow a real CA bundle from the full node:22 image (same Debian release,
# pulled from Docker Hub over 443). node:22-slim ships WITHOUT a system CA
# store, so https apt fetches would otherwise fail with "No system
# certificates available" even against a perfectly valid mirror cert.
COPY --from=node:22 /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

# Install system dependencies.
#
# We fetch over https:// rather than the default http:// Debian mirrors:
# some networks (corporate firewalls / VPNs) refuse outbound port 80, so
# the http mirrors fail with "connection refused" while 443 stays open.
# https is first-class on Debian and, with the CA bundle copied in above,
# fully certificate-verified. We also retry transient fetch failures so a
# single dropped connection (common under QEMU emulation for the
# non-native arch) doesn't kill the whole build.
RUN set -eux; \
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
      [ -f "$f" ] && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' "$f" || true; \
    done; \
    echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries; \
    apt-get update && \
    apt-get install -y \
    sqlite3 \
    python3 \
    python3-pip \
    python3-dev \
    supervisor \
    ffmpeg \
    alsa-utils \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create necessary directories
WORKDIR /app
RUN mkdir -p /data /data/log /tmp/d_cmd /app/byh_app && chown node:node /app/byh_app

# Set up Node.js environment
COPY --chown=node:node byh_app/backyardhero/package*.json /app/byh_app/
WORKDIR /app/byh_app
USER node
RUN npm ci

# Copy Next.js application files
COPY --chown=node:node byh_app/backyardhero /app/byh_app/


# Build Next.js application. Dev builds (docker-compose-dev.yml) set
# PRUNE_DEV_DEPS=false: `next dev` needs the devDependencies (tailwindcss,
# postcss, autoprefixer, sass) that the prune would strip.
ARG PRUNE_DEV_DEPS=true
RUN npm run build && if [ "$PRUNE_DEV_DEPS" = "true" ]; then npm prune --omit=dev; fi
USER root

# Copy Python application files
WORKDIR /app
COPY --chown=node:node pythings/ /app/pythings/

RUN pip3 install --no-cache-dir --break-system-packages -r pythings/requirements.txt

# Copy Supervisor configuration
COPY healthcheck.js /app/healthcheck.js
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# M8: run the application processes as the unprivileged `node` user (uid
# 1000, shipped by the node base image) instead of root. supervisord itself
# still starts as root (PID 1) so the entrypoint can fix bind-mount
# ownership, but every program it launches drops to `node`. Give `node`
# ownership of the build output + runtime dirs baked into the image so
# `next start` (which writes .next/cache) and the Python services can write.
RUN mkdir -p /data /data/log /tmp/d_cmd /tmp/ota_staging \
    && chown -R node:node /data /tmp/d_cmd /tmp/ota_staging

# Expose port for Next.js app
EXPOSE 1776

# Set environment variables
ENV SERIAL_PORT=/dev/ttyACM0
ENV SERIAL_BAUD=115200
ENV LED_STATE_FILE=/data/ledstate
ENV NODE_ENV=production
ENV PORT=1776

# M8: container healthcheck. Node 22 ships a global fetch(), so we don't
# need curl/wget installed. Generous start-period covers the Next build
# server + Python services coming up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node /app/healthcheck.js

# Entrypoint prepares dirs + rotates logs (as root) then execs supervisord,
# which launches each program as the non-root `node` user.
CMD ["/usr/local/bin/docker-entrypoint.sh"]