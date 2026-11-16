'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTtsController, resolveTts, validateTts, voicesFile, PREVIEW_TEXT } = require('../src/ttsSettings');
const { readSettings, writeSettings } = require('../src/settings');

const VOICES = ['Thiện Minh', 'Ngọc Huyền'];
const base = { speed: 1, pauseMs: 400, voice: 'Thiện Minh', model: '', bitrate: '96k' };
const okWith = (patch) => validateTts({ ...base, ...patch }, VOICES).ok;

test('TC-75: validateTts miền giá trị', () => {
  for (const speed of [0.7, 1.2, 1.05]) assert.ok(okWith({ speed }), `speed ${speed}`);
  for (const speed of [0.69, 1.21, 1.03, 'abc', NaN]) assert.ok(!okWith({ speed }), `speed ${speed}`);
  for (const pauseMs of [0, 2000]) assert.ok(okWith({ pauseMs }));
  for (const pauseMs of [-1, 2001, 1.5, '400']) assert.ok(!okWith({ pauseMs }), `pause ${pauseMs}`);
  for (const bitrate of ['64k', '96k', '128k']) assert.ok(okWith({ bitrate }));
  assert.ok(!okWith({ bitrate: '80k' }));
  for (const model of ['', 'v3nano']) assert.ok(okWith({ model }));
  assert.ok(!okWith({ model: 'abc' }));
  assert.ok(!okWith({ voice: 'Giọng lạ' }));
  assert.deepStrictEqual(Object.keys(validateTts({ ...base, speed: 2, voice: 'x' }, VOICES).errors).sort(), ['speed', 'voice']);
  assert.deepStrictEqual(validateTts({ ...base, extra: 1 }, VOICES).value, base);
});

test('TC-76: nguồn giá trị settings → env → mặc định', () => {
  const env = { SBOK_TTS_SPEED: '0.8', SBOK_TTS_PAUSE_MS: '300', SBOK_TTS_VOICE: 'Ngọc Huyền', VIENEU_MODEL: 'v3nano',
    SBOK_MP3_BITRATE: '64k' };
  assert.deepStrictEqual(resolveTts({ tts: base }, env), base);
  assert.deepStrictEqual(resolveTts({}, env), { speed: 0.8, pauseMs: 300, voice: 'Ngọc Huyền', model: 'v3nano', bitrate: '64k' });
  assert.deepStrictEqual(resolveTts({}, {}), { speed: 1, pauseMs: 400, voice: 'Thiện Minh', model: '', bitrate: '96k' });
});

function setup({ ready = true, busy = false, prefetch, synthPreview } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-tts-'));
  const runtime = path.join(dir, 'runtime');
  fs.mkdirSync(runtime);
  fs.writeFileSync(voicesFile(runtime, ''), JSON.stringify(VOICES));
  const file = path.join(dir, 'settings.json');
  writeSettings(file, { dataDir: dir });
  const calls = { prefetch: [], preview: [] };
  const ctl = createTtsController({
    settingsFile: () => file, runtimeDir: () => runtime, isReady: () => ready, isBusy: () => busy,
    prefetch: prefetch || (async (m) => calls.prefetch.push(m)),
    synthPreview: synthPreview || (async (tts, text) => {
      calls.preview.push([tts, text]);
      const out = path.join(dir, 'preview.mp3');
      fs.writeFileSync(out, 'mp3');
      return out;
    }),
    store: { readSettings, writeSettings }, env: {}, log: () => {},
  });
  return { dir, runtime, file, ctl, calls };
}

test('TC-76: synthesizeBatch đặt env con và bitrate theo cấu hình đã resolve (thắng env app)', async () => {
  const { EventEmitter } = require('events');
  const { synthesizeBatch } = require('../src/tts/ttsRunner');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-tts-env-'));
  let seen;
  const spawnFn = (cmd, args, opts) => {
    seen = { args, env: opts.env };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const tts = { speed: 0.85, pauseMs: 0, voice: 'Ngọc Huyền', model: 'v3nano', bitrate: '128k' };
  await synthesizeBatch({ pythonPath: 'py', ffmpegPath: 'ff', mp3Bitrate: '64k', tts },
    [{ in: path.join(dir, '1.txt'), out: path.join(dir, '1.mp3') }], () => {}, () => {}, spawnFn);
  assert.strictEqual(seen.args[seen.args.indexOf('--bitrate') + 1], '128k');
  assert.strictEqual(seen.env.SBOK_TTS_SPEED, '0.85');
  assert.strictEqual(seen.env.SBOK_TTS_PAUSE_MS, '0');
  assert.strictEqual(seen.env.SBOK_TTS_VOICE, 'Ngọc Huyền');
  assert.strictEqual(seen.env.VIENEU_MODEL, 'v3nano');
  assert.strictEqual(seen.env.HF_HUB_OFFLINE, '1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-78: IPC lưu giá trị sai/thiếu trường → từ chối, settings.json không đổi', async () => {
  const { dir, file, ctl } = setup();
  const before = fs.readFileSync(file, 'utf8');
  for (const bad of [{ ...base, speed: 5 }, { speed: 1 }, null, 'x', { ...base, voice: 'Giọng lạ' }]) {
    const r = await ctl.save(bad);
    assert.strictEqual(r.ok, false);
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  const r = await ctl.save({ ...base, speed: 1.1 });
  assert.ok(r.ok);
  assert.strictEqual(readSettings(file).tts.speed, 1.1);
  assert.strictEqual(readSettings(file).dataDir, dir);
  assert.strictEqual(ctl.get().tts.speed, 1.1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-79: nghe thử bị từ chối khi có job hoặc chưa ready; khi rảnh đọc câu mẫu bằng cấu hình đang chọn', async () => {
  for (const opts of [{ busy: true }, { ready: false }]) {
    const { dir, ctl, calls } = setup(opts);
    const r = await ctl.preview(base);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(calls.preview.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const { dir, ctl, calls } = setup();
  const r = await ctl.preview({ ...base, speed: 0.9 });
  assert.ok(r.ok);
  assert.match(r.audio, /^data:audio\/mpeg;base64,/);
  assert.deepStrictEqual(calls.preview, [[{ ...base, speed: 0.9 }, PREVIEW_TEXT]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-80: chọn v3nano chưa có cache → tải trước khi lưu; tải lỗi → không lưu, báo lỗi ở ô model', async () => {
  const failing = setup({ prefetch: async () => { throw new Error('tải model lỗi: mất mạng'); } });
  const before = fs.readFileSync(failing.file, 'utf8');
  const r1 = await failing.ctl.save({ ...base, model: 'v3nano' });
  assert.strictEqual(r1.ok, false);
  assert.match(r1.errors.model, /mất mạng/);
  assert.strictEqual(fs.readFileSync(failing.file, 'utf8'), before);
  fs.rmSync(failing.dir, { recursive: true, force: true });

  const { dir, runtime, file, ctl, calls } = setup({
    prefetch: async (m) => fs.writeFileSync(voicesFile(runtime, m), JSON.stringify(['Thiện Minh'])),
  });
  const r2 = await ctl.save({ ...base, model: 'v3nano' });
  assert.ok(r2.ok);
  assert.strictEqual(readSettings(file).tts.model, 'v3nano');
  assert.strictEqual(calls.prefetch.length, 0); // prefetch giả ở trên ghi file thay vì đẩy vào calls
  assert.deepStrictEqual(ctl.voices('v3nano'), ['Thiện Minh']);
  fs.rmSync(dir, { recursive: true, force: true });
});
