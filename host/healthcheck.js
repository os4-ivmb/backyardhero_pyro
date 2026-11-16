const net = require('node:net');
const fs = require('node:fs/promises');

async function check() {
  await Promise.all([
    fetch('http://127.0.0.1:1776/', { signal: AbortSignal.timeout(3000) })
      .then((response) => { if (!response.ok) throw new Error('Web app unavailable'); }),
    new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: 8090 });
      socket.setTimeout(3000);
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
      socket.once('timeout', () => { socket.destroy(); reject(new Error('WebSocket unavailable')); });
    }),
    fs.stat(`${process.env.BYH_DATA_DIR || '/data'}/state`).then((stat) => {
      if (Date.now() - stat.mtimeMs > 15000) throw new Error('Daemon state stale');
    }),
  ]);
}
check().then(() => process.exit(0), (error) => { console.error(error.message); process.exit(1); });
