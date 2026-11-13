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
  assert.strictEqual(config.port, 7000);
});

test('TC-51: loadConfig bỏ qua PYTHON_PATH/FFMPEG_PATH/SBOK_WORK_DIR, workDir lấy từ dataDir', () => {
  const env = { PYTHON_PATH: 'C:\\x\\python.exe', FFMPEG_PATH: 'C:\\x\\ffmpeg.exe', SBOK_WORK_DIR: 'C:\\x' };
  const workDir = path.join(os.tmpdir(), 'sbok-data', 'work');
  const config = loadConfig(env, workDir);
  assert.strictEqual(config.pythonPath, 'python');
  assert.strictEqual(config.ffmpegPath, 'ffmpeg');
  assert.strictEqual(config.workDir, workDir);
  assert.strictEqual(config.jobsDir, path.join(workDir, 'jobs'));
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.ok(!/^(PYTHON_PATH|FFMPEG_PATH|SBOK_WORK_DIR)=/m.test(example));
});

test('TC-67: chạy local không Cloudflare: backendUrl http://localhost giữ nguyên, bỏ / cuối; mặc định production', () => {
  assert.strictEqual(loadConfig({ SBOK_BACKEND_URL: 'http://localhost:2040/' }).backendUrl, 'http://localhost:2040');
  assert.strictEqual(loadConfig({}).backendUrl, 'https://sbok.xvibe.me/api/sbok');
  assert.strictEqual(loadConfig({ SBOK_WORKER_PORT: '' }).port, 7860);
  assert.strictEqual(loadConfig({}).tunnelToken, '');
});

test('loadEnvFile không có .env thì trả null, env giữ nguyên', () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-env-none-'));
  const env = {};
  assert.strictEqual(loadEnvFile([missing], env), null);
  assert.deepStrictEqual(env, {});
});
