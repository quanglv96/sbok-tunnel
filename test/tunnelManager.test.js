'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createTunnelManager, backoffMs, BACKOFF_CAP_MS } = require('../src/tunnelManager');

test('TC-34: backoff tăng dần và không vượt trần (≤ 30 s)', () => {
  assert.strictEqual(backoffMs(0), 1000);
  assert.strictEqual(backoffMs(1), 2000);
  assert.ok(backoffMs(50) === BACKOFF_CAP_MS && BACKOFF_CAP_MS <= 30_000);
});

test('TC-34: cloudflared bị kill -> log dòng rớt và tự khởi động lại', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const spawned = [];
  const logs = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.kill = () => {};
    spawned.push(child);
    return child;
  };
  const manager = createTunnelManager({ cloudflaredPath: 'cloudflared', metricsPort: 1, tunnelToken: 't' },
    { spawnImpl, log: (l) => logs.push(l), fetchImpl: async () => ({ ok: true }) });

  manager.start();
  spawned[0].emit('exit', 1);
  assert.match(logs[0], /Tunnel rớt/);
  t.mock.timers.tick(1000);
  assert.strictEqual(spawned.length, 2);
  manager.stop();
});
