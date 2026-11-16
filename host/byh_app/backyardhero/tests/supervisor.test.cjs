const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Supervisor } = require('../../../desktop/src/supervisor');

test('desktop logs rotate while services remain running', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'byh-log-test-'));
  const supervisor = new Supervisor({ logDir: directory });
  supervisor.register({ name: 'daemon' });
  const log = supervisor._logStreamFor('daemon');
  try {
    log.write(Buffer.alloc(10 * 1024 * 1024, 'a'));
    log.write('after rotation');
    assert.equal(fs.statSync(path.join(directory, 'daemon.log.1')).size, 10 * 1024 * 1024);
    assert.equal(fs.readFileSync(path.join(directory, 'daemon.log'), 'utf8'), 'after rotation');
    log.write(Buffer.alloc(10 * 1024 * 1024, 'b'));
    assert.ok(fs.statSync(path.join(directory, 'daemon.log')).size <= 10 * 1024 * 1024);
    assert.equal(fs.readdirSync(directory).length, 2);
  } finally {
    log.end();
    fs.rmSync(directory, { recursive: true });
  }
});
