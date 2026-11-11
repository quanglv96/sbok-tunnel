'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { startupCheck } = require('../src/startupCheck');

const base = {
  workDir: path.join(os.tmpdir(), 'sbok-startup-test'),
  minFreeGb: 0,
  cloudflaredPath: 'sbok-no-such-cloudflared',
  pythonPath: 'sbok-no-such-python',
  ffmpegPath: 'sbok-no-such-ffmpeg',
  workerToken: 'w',
  r2: { endpoint: 'e', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' },
};

test('chế độ local (không tunnel token): bỏ kiểm cloudflared, không đòi tunnelToken', async () => {
  const { checks } = await startupCheck({ ...base, tunnelToken: '' });
  assert.ok(!checks.some((c) => c.name === 'cloudflared'));
  assert.strictEqual(checks.find((c) => c.name === 'Cấu hình env').ok, true);
});

test('có tunnel token: kiểm cloudflared', async () => {
  const { checks } = await startupCheck({ ...base, tunnelToken: 't' });
  assert.strictEqual(checks.find((c) => c.name === 'cloudflared').ok, false);
});
