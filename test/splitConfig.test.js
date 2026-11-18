'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveSplit, validateSplit } = require('../src/settings');
const { notifyChapterSplitFailed } = require('../src/adminAlert');
const { loadConfig } = require('../src/config');
const { ensureRuntime } = require('../src/runtimeSetup');

/** FEAT-007: cấu hình tách chương (TC-19, TC-20), báo admin (TC-15, TC-16), cài Ollama (TC-21…TC-23). */

test('TC-19: UI thắng env, env thắng mặc định qwen2.5:3b', () => {
  const env = { SBOK_SPLIT_MODE: 'heuristic', SBOK_LLM_MODEL: 'qwen2.5:7b' };
  assert.deepStrictEqual(resolveSplit({ split: { mode: 'llm', model: 'llama3:8b' } }, env),
    { mode: 'llm', model: 'llama3:8b', source: 'ui' });
  assert.deepStrictEqual(resolveSplit({}, env), { mode: 'heuristic', model: 'qwen2.5:7b', source: 'env' });
  assert.deepStrictEqual(resolveSplit({}, {}), { mode: '', model: 'qwen2.5:3b', source: 'default' });
  assert.deepStrictEqual(resolveSplit(null, { SBOK_SPLIT_MODE: ' LLM ' }), { mode: 'llm', model: 'qwen2.5:3b', source: 'env' });
});

test('TC-20: giá trị lạ = chưa chọn ở nguồn đó; UI kiểm mode/model', () => {
  assert.deepStrictEqual(resolveSplit({}, { SBOK_SPLIT_MODE: 'ai', SBOK_LLM_MODEL: 'bad model;rm' }),
    { mode: '', model: 'qwen2.5:3b', source: 'default' });
  assert.deepStrictEqual(resolveSplit({ split: { mode: 'xyz' } }, { SBOK_SPLIT_MODE: 'llm' }).mode, 'llm');
  assert.deepStrictEqual(validateSplit({ mode: '', model: '' }), { ok: true, value: { mode: '', model: 'qwen2.5:3b' } });
  assert.deepStrictEqual(validateSplit({ mode: 'llm', model: ' qwen2.5:7b ' }), { ok: true, value: { mode: 'llm', model: 'qwen2.5:7b' } });
  const bad = validateSplit({ mode: 'ai', model: '--help & x' });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.mode && bad.errors.model);
});

const PAYLOAD = { taskId: 't1', bookTitle: 'Sách', model: 'qwen2.5:3b', attempts: 3, error: 'e'.repeat(5000), host: 'pc',
  occurredAt: '2026-11-18T05:00:00.000Z' };

test('config: URL admin bỏ / cuối, thiếu thì rỗng', () => {
  const cfg = loadConfig({ SBOK_ADMIN_ALERT_URL: 'https://admin.example.com//', SBOK_ADMIN_API_KEY: 'k' }, '/tmp/w');
  assert.strictEqual(cfg.adminAlertUrl, 'https://admin.example.com');
  assert.strictEqual(cfg.adminApiKey, 'k');
  assert.strictEqual(loadConfig({}, '/tmp/w').adminAlertUrl, '');
});

test('báo admin: POST đúng endpoint, header X-API-Key, lỗi cuối bị cắt', async () => {
  let call;
  const ok = await notifyChapterSplitFailed({ adminAlertUrl: 'https://a.example', adminApiKey: 'k' }, PAYLOAD, {
    log: () => {}, fetchFn: async (url, opts) => { call = { url, opts }; return { ok: true, status: 202 }; },
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(call.url, 'https://a.example/api/alerts/chapter-split');
  assert.strictEqual(call.opts.headers['X-API-Key'], 'k');
  const body = JSON.parse(call.opts.body);
  assert.strictEqual(body.error.length, 2000);
  assert.strictEqual(body.attempts, 3);
});

test('TC-15: thiếu URL hoặc API key → không gọi HTTP, log cảnh báo', async () => {
  for (const cfg of [{ adminAlertUrl: '', adminApiKey: 'k' }, { adminAlertUrl: 'https://a.example', adminApiKey: '' }]) {
    const logs = [];
    let called = false;
    const ok = await notifyChapterSplitFailed(cfg, PAYLOAD, { log: (l) => logs.push(l), fetchFn: async () => { called = true; } });
    assert.strictEqual(ok, false);
    assert.strictEqual(called, false);
    assert.match(logs[0], /chưa cấu hình/);
  }
});

test('TC-16: admin-service 500 / timeout → log, không ném, không lộ key trong log', async () => {
  const cfg = { adminAlertUrl: 'https://a.example', adminApiKey: 'secret-key' };
  const logs = [];
  const log = (l) => logs.push(l);
  assert.strictEqual(await notifyChapterSplitFailed(cfg, PAYLOAD, { log, fetchFn: async () => ({ ok: false, status: 500 }) }), false);
  assert.strictEqual(await notifyChapterSplitFailed(cfg, PAYLOAD, {
    log, fetchFn: async () => { throw new Error('The operation was aborted due to timeout'); },
  }), false);
  assert.match(logs[0], /HTTP 500/);
  assert.match(logs[1], /timeout/);
  assert.ok(logs.every((l) => !l.includes('secret-key')));
});

/** Python/ffmpeg/model TTS coi như đã có (run luôn ok) để chỉ kiểm bước Ollama. */
function runtimeDeps(ollama) {
  const calls = { download: [], run: [] };
  return {
    calls,
    deps: {
      run: async (cmd, args) => { calls.run.push([cmd, ...args].join(' ')); return { ok: true, out: '' }; },
      download: async (item, dest) => { calls.download.push(item.name); return dest; },
      ollama,
    },
  };
}

function fakeOllama(states, { pullFails = false } = {}) {
  const calls = [];
  return {
    calls,
    isReady: async () => { calls.push('isReady'); return states.shift() || { running: true, hasModel: true }; },
    serve: (exe, env) => { calls.push('serve'); assert.ok(env.OLLAMA_MODELS.includes('ollama-models')); },
    waitReady: async () => { calls.push('waitReady'); return { running: true, hasModel: false }; },
    pull: async (model) => { calls.push(`pull ${model}`); if (pullFails) throw new Error('Pull: mạng lỗi'); },
  };
}

const tmpData = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-rt-'));

test('TC-21: Ollama đã chạy + có model → không tải, không pull', async () => {
  const ol = fakeOllama([{ running: true, hasModel: true }]);
  const { deps, calls } = runtimeDeps(ol);
  const rt = await ensureRuntime({ dataDir: tmpData(), log: () => {}, deps, split: { mode: 'llm', model: 'qwen2.5:3b' } });
  assert.deepStrictEqual(rt.llm, { ok: true, detail: 'Ollama + qwen2.5:3b' });
  assert.deepStrictEqual(rt.errors, []);
  assert.deepStrictEqual(ol.calls, ['isReady']);
  assert.deepStrictEqual(calls.download, []);
});

test('TC-22: thiếu Ollama → tải, giải nén, chạy serve; thiếu model → pull', async () => {
  const ol = fakeOllama([{ running: false, hasModel: false }, { running: true, hasModel: true }]);
  const { deps, calls } = runtimeDeps(ol);
  const steps = [];
  const rt = await ensureRuntime({ dataDir: tmpData(), log: () => {}, deps, split: { mode: '', model: 'qwen2.5:3b' },
    onProgress: (p) => steps.push(p) });
  assert.strictEqual(rt.llm.ok, true);
  assert.deepStrictEqual(calls.download, ['Ollama win64']);
  assert.ok(calls.run.some((c) => c.startsWith('tar -xf') && c.includes('ollama')));
  assert.deepStrictEqual(ol.calls, ['isReady', 'serve', 'waitReady', 'pull qwen2.5:3b', 'isReady']);
  assert.ok(steps.every((p) => p.steps === 7));
});

test('TC-38: ensureRuntime mode llm → log từng bước Ollama (kiểm, tải mốc %, giải nén, serve, pull mốc %) kèm ms; '
  + 'bước lỗi có mã', async () => {
  const ol = fakeOllama([{ running: false, hasModel: false }, { running: true, hasModel: true }]);
  ol.pull = async (model, { onProgress }) => { ol.calls.push(`pull ${model}`); [0, 55, 100].forEach((c) => onProgress(c, 100)); };
  const { deps } = runtimeDeps(ol);
  deps.download = async (item, dest, _x, cb) => { [0, 25, 100].forEach((r) => cb(r, 100)); return dest; };
  const logs = [];
  await ensureRuntime({ dataDir: tmpData(), log: (l) => logs.push(l), deps, split: { mode: 'llm', model: 'qwen2.5:3b' } });
  for (const name of ['Python/VieNeu-TTS', 'ffmpeg', 'Ollama: kiểm', 'Ollama: tải', 'Ollama: giải nén', 'Ollama: serve',
    'Ollama: pull qwen2.5:3b']) {
    assert.ok(logs.includes(`[setup] [${name}] bắt đầu`), `${name}\n${logs.join('\n')}`);
    assert.ok(logs.some((l) => l.startsWith(`[setup] [${name}] xong (`) && /\(\d+ ms/.test(l)), `${name}\n${logs.join('\n')}`);
  }
  assert.deepStrictEqual(logs.filter((l) => l.startsWith('[setup] [Ollama: tải] ') && l.endsWith('%')),
    ['[setup] [Ollama: tải] 0%', '[setup] [Ollama: tải] 20%', '[setup] [Ollama: tải] 100%']);
  assert.deepStrictEqual(logs.filter((l) => l.startsWith('[setup] [Ollama: pull qwen2.5:3b] ') && l.endsWith('%')),
    ['[setup] [Ollama: pull qwen2.5:3b] 0%', '[setup] [Ollama: pull qwen2.5:3b] 50%', '[setup] [Ollama: pull qwen2.5:3b] 100%']);

  const bad = fakeOllama([{ running: true, hasModel: false }]);
  bad.pull = async () => { throw Object.assign(new Error('pull lỗi'), { code: 'ECONNRESET' }); };
  const badLogs = [];
  await ensureRuntime({ dataDir: tmpData(), log: (l) => badLogs.push(l), deps: runtimeDeps(bad).deps, split: { mode: 'llm', model: 'm' } });
  assert.ok(badLogs.some((l) => /^\[setup\] \[Ollama: pull m\] lỗi \(\d+ ms\): pull lỗi \(ECONNRESET\)$/.test(l)), badLogs.join('\n'));
});

test('TC-23: pull lỗi → mode llm báo lỗi môi trường; chưa chọn → không chặn (dùng heuristic); heuristic không kiểm', async () => {
  const llm = runtimeDeps(fakeOllama([{ running: true, hasModel: false }], { pullFails: true }));
  const a = await ensureRuntime({ dataDir: tmpData(), log: () => {}, deps: llm.deps, split: { mode: 'llm', model: 'm' } });
  assert.strictEqual(a.llm.ok, false);
  assert.match(a.errors.join(), /Ollama\/LLM: Pull: mạng lỗi/);

  const auto = runtimeDeps(fakeOllama([{ running: true, hasModel: false }], { pullFails: true }));
  const b = await ensureRuntime({ dataDir: tmpData(), log: () => {}, deps: auto.deps, split: { mode: '', model: 'm' } });
  assert.strictEqual(b.llm.ok, false);
  assert.deepStrictEqual(b.errors, []);

  const ol = fakeOllama([]);
  const c = await ensureRuntime({ dataDir: tmpData(), log: () => {}, deps: runtimeDeps(ol).deps, split: { mode: 'heuristic', model: 'm' } });
  assert.strictEqual(c.llm, undefined);
  assert.deepStrictEqual(ol.calls, []);
});
