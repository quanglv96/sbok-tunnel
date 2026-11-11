'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSettings, writeSettings } = require('../src/settings');

test('TC-46: không có file → {}; JSON hỏng → {} không ném lỗi; ghi rồi đọc lại đúng', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-settings-'));
  const file = path.join(dir, 'sub', 'settings.json');
  assert.deepStrictEqual(readSettings(file), {});

  writeSettings(file, { dataDir: 'D:\\sbok', appVersion: '0.1.0' });
  assert.deepStrictEqual(readSettings(file), { dataDir: 'D:\\sbok', appVersion: '0.1.0' });
  assert.ok(!fs.existsSync(`${file}.tmp`));

  fs.writeFileSync(file, '{hỏng');
  assert.deepStrictEqual(readSettings(file), {});
  fs.writeFileSync(file, '[1,2]');
  assert.deepStrictEqual(readSettings(file), {});
});
