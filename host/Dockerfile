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
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create necessary directories
WORKDIR /app
RUN mkdir -p /data /data/log /tmp/d_cmd

# Set up Node.js environment
COPY byh_app/backyardhero/package*.json /app/byh_app/
WORKDIR /app/byh_app
RUN npm ci

# Copy Next.js application files
COPY byh_app/backyardhero /app/byh_app/

RUN ls /app/byh_app/

# Build Next.js application
RUN npm run build

# Copy Python application files
WORKDIR /app
COPY pythings/ /app/pythings/

RUN pip3 install --no-cache-dir --break-system-packages -r pythings/requirements.txt

# Copy Supervisor configuration
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Expose port for Next.js app
EXPOSE 1776

# Set environment variables
ENV SERIAL_PORT=/dev/ttyACM0
ENV SERIAL_BAUD=115200
ENV LED_STATE_FILE=/data/ledstate
ENV NODE_ENV=production
ENV PORT=1776

# Truncate persisted app logs on each container process start, then hand off to Supervisor.
CMD ["sh", "-c", "mkdir -p /data/log && : > /data/log/command.log && : > /data/log/firing_profiles.log && : > /data/log/daemon.err && exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf"]