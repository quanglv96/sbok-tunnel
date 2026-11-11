'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createR2Uploader } = require('../src/r2Uploader');

const mp3 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-')), '1.mp3');
fs.writeFileSync(mp3, 'ID3');

function uploader(failures) {
  const c = {
    calls: 0,
    send: async () => {
      c.calls++;
      if (c.calls <= failures) throw new Error('R2 down');
    },
  };
  const up = createR2Uploader({ bucket: 'b' }, { client: c, makeCommand: (p) => p, log: () => {}, wait: async () => {} });
  return { c, up };
}

test('TC-27: R2 lỗi 2 lần rồi thành công', async () => {
  const { c, up } = uploader(2);
  await up.upload('k', mp3);
  assert.strictEqual(c.calls, 3);
});

test('TC-27: R2 lỗi 3 lần -> ném lỗi, MP3 local vẫn còn', async () => {
  const { c, up } = uploader(3);
  await assert.rejects(up.upload('k', mp3));
  assert.strictEqual(c.calls, 3);
  assert.ok(fs.existsSync(mp3));
});
