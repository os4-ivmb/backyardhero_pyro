#!/bin/sh
# Container entrypoint (M8). Runs as root only to prepare the runtime
# environment, then hands off to supervisord which launches every
# application process as the unprivileged `node` user (see supervisord.conf
# `user=node` directives).
set -e

# Ensure the runtime directories exist. Several of these are bind-mounted
# from the host and arrive owned by root, so we (root) create + chown them
# before dropping privileges.
mkdir -p /data /data/log /config /tmp/d_cmd /tmp/ota_staging

# M8: rotate the persisted logs instead of truncating them. The old CMD did
# `: > file`, which destroyed the previous run's output -- including any
# crash backtrace -- on every (re)start. Keep one generation (.1) so a
# crash-loop is still diagnosable.
for log in /data/log/command.log /data/log/firing_profiles.log /data/log/daemon.err; do
  if [ -f "$log" ] && [ -s "$log" ]; then
    mv -f "$log" "$log.1"
  fi
  : > "$log"
done

# Hand the writable trees to the non-root app user. Bind-mounted volumes
# come in owned by host root; without this the dropped-privilege processes
# couldn't write state/config/command files. Best-effort: on some hosts the
# chown of a bind mount is restricted, in which case the dirs may already be
# writable (e.g. world-writable host dirs) and we continue regardless.
chown -R node:node /data /config /tmp/d_cmd /tmp/ota_staging 2>/dev/null || true

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
