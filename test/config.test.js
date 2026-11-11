'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEnvFile, loadConfig } = require('../src/config');

test('loadEnvFile nạp .env đầu tiên tìm thấy, không ghi đè biến đã có', () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-env-none-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-env-'));
  fs.writeFileSync(path.join(dir, '.env'), '# chú thích\nPYTHON_PATH=C:\\Python312\\python.exe\nR2_BUCKET=sbok\nSBOK_WORKER_PORT=9000\n');
  const env = { SBOK_WORKER_PORT: '7000' };

  const file = loadEnvFile([missing, dir], env);

  assert.strictEqual(file, path.join(dir, '.env'));
  assert.strictEqual(env.PYTHON_PATH, 'C:\\Python312\\python.exe');
  assert.strictEqual(env.R2_BUCKET, 'sbok');
  assert.strictEqual(env.SBOK_WORKER_PORT, '7000');
  const config = loadConfig(env);
  assert.strictEqual(config.pythonPath, 'C:\\Python312\\python.exe');
  assert.strictEqual(config.port, 7000);
});

test('loadEnvFile không có .env thì trả null, env giữ nguyên', () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-env-none-'));
  const env = {};
  assert.strictEqual(loadEnvFile([missing], env), null);
  assert.deepStrictEqual(env, {});
});
