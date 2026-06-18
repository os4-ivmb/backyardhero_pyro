'use strict';

/**
 * Minimal process supervisor -- the desktop equivalent of supervisord.conf.
 *
 * Each managed service is spawned as a child process; stdout/stderr are
 * appended to a per-service rotating log file under the user log dir; and a
 * crashed service is restarted with capped exponential backoff (mirrors
 * supervisord's autorestart=true). On shutdown the services are stopped in
 * reverse start order.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const RESTART_BACKOFF_MS = 1000;
const RESTART_BACKOFF_MAX_MS = 15000;
// If a service stays up at least this long, treat the next crash as fresh
// (reset the backoff) rather than part of a crash loop.
const HEALTHY_UPTIME_MS = 20000;

class Supervisor extends EventEmitter {
  constructor({ logDir }) {
    super();
    this.logDir = logDir;
    this.services = new Map(); // name -> { def, child, restarts, startedAt, stopping, logStream }
    this.shuttingDown = false;
  }

  /**
   * @param {object} def
   * @param {string} def.name
   * @param {string} def.command       executable to run
   * @param {string[]} def.args
   * @param {string} def.cwd
   * @param {object} def.env
   */
  register(def) {
    this.services.set(def.name, {
      def,
      child: null,
      restarts: 0,
      startedAt: 0,
      stopping: false,
      logStream: null,
    });
  }

  startAll() {
    for (const name of this.services.keys()) this._start(name);
  }

  _logStreamFor(name) {
    const s = this.services.get(name);
    if (s.logStream) return s.logStream;
    const file = path.join(this.logDir, `${name}.log`);
    // Rotate the previous run's log so a crash loop stays diagnosable but logs
    // don't grow without bound (one generation, like docker-entrypoint.sh).
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 0) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      /* best effort */
    }
    s.logStream = fs.createWriteStream(file, { flags: 'a' });
    return s.logStream;
  }

  _start(name) {
    const s = this.services.get(name);
    if (!s || this.shuttingDown) return;
    const { def } = s;
    const log = this._logStreamFor(name);

    const stamp = () => new Date().toISOString();
    log.write(`\n[${stamp()}] [supervisor] starting ${def.command} ${(def.args || []).join(' ')}\n`);

    const child = spawn(def.command, def.args || [], {
      cwd: def.cwd,
      env: def.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    s.child = child;
    s.startedAt = Date.now();
    s.stopping = false;

    child.stdout.on('data', (d) => log.write(d));
    child.stderr.on('data', (d) => log.write(d));

    child.on('error', (err) => {
      log.write(`[${stamp()}] [supervisor] ${name} failed to spawn: ${err.message}\n`);
      this.emit('service-error', { name, error: err });
    });

    child.on('exit', (code, signal) => {
      log.write(`[${stamp()}] [supervisor] ${name} exited code=${code} signal=${signal}\n`);
      s.child = null;
      this.emit('service-exit', { name, code, signal });

      if (this.shuttingDown || s.stopping) return;

      const uptime = Date.now() - s.startedAt;
      if (uptime > HEALTHY_UPTIME_MS) s.restarts = 0;
      else s.restarts += 1;

      const delay = Math.min(RESTART_BACKOFF_MAX_MS, RESTART_BACKOFF_MS * Math.max(1, s.restarts));
      log.write(`[${stamp()}] [supervisor] restarting ${name} in ${delay}ms (attempt ${s.restarts})\n`);
      setTimeout(() => this._start(name), delay);
    });

    this.emit('service-start', { name, pid: child.pid });
  }

  status() {
    const out = {};
    for (const [name, s] of this.services) {
      out[name] = {
        running: !!s.child,
        pid: s.child ? s.child.pid : null,
        restarts: s.restarts,
      };
    }
    return out;
  }

  async stopAll() {
    this.shuttingDown = true;
    // Reverse start order.
    const names = [...this.services.keys()].reverse();
    for (const name of names) {
      const s = this.services.get(name);
      if (!s.child) continue;
      s.stopping = true;
      try {
        s.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    // Give them a moment, then hard-kill stragglers.
    await new Promise((r) => setTimeout(r, 2500));
    for (const name of names) {
      const s = this.services.get(name);
      if (s.child) {
        try {
          s.child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
      if (s.logStream) {
        try {
          s.logStream.end();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

module.exports = { Supervisor };
