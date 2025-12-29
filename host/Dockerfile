FROM node:18-slim

# Install system dependencies
RUN apt-get update && \
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

# Start Supervisor to manage all processes
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]