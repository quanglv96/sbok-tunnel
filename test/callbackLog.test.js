'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBackendClient, backendBootLines } = require('../src/backendClient');
const { createJobServer } = require('../src/jobServer');

const FAKE_TOKEN = 'tok-unit-test-0001';
const BACKEND = 'http://localhost:2040';

/** fetch giả: `answers` là danh sách { status, body } trả lần lượt (hết danh sách thì lặp phần tử cuối). */
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    return { status: a.status, text: async () => a.body ?? '' };
  };
  return { fn, calls };
}

function client(answers) {
  const lines = [];
  const f = fakeFetch(answers);
  const api = createBackendClient({ backendUrl: BACKEND, workerToken: FAKE_TOKEN },
    { fetchImpl: f.fn, log: (l) => lines.push(l) });
  return { api, lines, calls: f.calls };
}

test('TC-97: boot log URL callback; local + host lạ → cảnh báo; localhost/127.0.0.1/host.docker.internal → không', () => {
  const remote = backendBootLines({ backendUrl: 'https://sbok.xvibe.me/api/sbok', workerToken: FAKE_TOKEN, tunnelToken: '' });
  assert.strictEqual(remote[0], 'Callback backend: https://sbok.xvibe.me/api/sbok');
  assert.strictEqual(remote.length, 2, 'chế độ local mà host không phải localhost phải có cảnh báo');
  for (const url of ['http://localhost:2040', 'http://127.0.0.1:2040', 'http://host.docker.internal:2040']) {
    assert.deepStrictEqual(backendBootLines({ backendUrl: url, workerToken: FAKE_TOKEN, tunnelToken: '' }),
      [`Callback backend: ${url}`], url);
  }
  // có token Cloudflare (không phải local) → không cảnh báo
  assert.strictEqual(backendBootLines({ backendUrl: 'https://sbok.xvibe.me/api/sbok', tunnelToken: 'cf' }).length, 1);
  assert.ok(remote.every((l) => !l.includes(FAKE_TOKEN)), 'log không chứa token');
});

test('TC-98: mỗi callback log path, task, status, ms; progress 2xx chỉ log khi đổi stage/chương', async () => {
  const { api, lines } = client([{ status: 204 }]);
  await api.progress('t1', 'PARSING');
  await api.progress('t1', 'TTS_PROCESSING', 'Chương 1/3 · 0% · tổng 0%');
  await api.progress('t1', 'TTS_PROCESSING', 'Chương 1/3 · 50% · tổng 10%');
  await api.progress('t1', 'TTS_PROCESSING', 'Chương 2/3 · 0% · tổng 33%');
  await api.complete('t1');
  assert.strictEqual(lines.length, 4, lines.join('\n'));
  assert.match(lines[0], /^Callback progress task t1 → HTTP 204 \(\d+ ms\)/);
  assert.match(lines[3], /^Callback complete task t1 → HTTP 204 \(\d+ ms\)$/);
});

test('TC-98: không 2xx → log URL đầy đủ (không token) + tối đa 200 ký tự đầu body; body rỗng không lỗi', async () => {
  const long = 'x'.repeat(201);
  const { api, lines } = client([{ status: 400, body: long }, { status: 400, body: '' }]);
  assert.strictEqual(await api.failed('t2', 'lỗi'), 400);
  const line = lines.find((l) => l.includes(`${BACKEND}/internal/worker/failed`));
  assert.ok(line, lines.join('\n'));
  assert.ok(line.includes('x'.repeat(200)) && !line.includes('x'.repeat(201)), 'cắt đúng 200 ký tự body');
  assert.strictEqual(await api.failed('t2', 'lỗi'), 400);
  assert.ok(lines.every((l) => !l.includes(FAKE_TOKEN)));
});

test('TC-98/TC-135: 404, 401, 409 ở bất kỳ callback nào → ném lỗi có cờ rejected; 400 thì không', async () => {
  const calls = {
    progress: (a) => a.progress('t3', 'VERIFYING'),
    chapterDone: (a) => a.chapterDone('t3', 'S', null, { index: 1, title: 'C1', sizeBytes: 1, durationSec: 1 }),
    complete: (a) => a.complete('t3'),
    failed: (a) => a.failed('t3', 'x'),
    violation: (a) => a.violation('t3', '/JS'),
    chapterUploaded: (a) => a.chapterUploaded('t3', 1, 'books/t3/1.mp3', 3),
    chapterUploadFailed: (a) => a.chapterUploadFailed('t3', 1, true),
    quotaOk: (a) => a.quotaOk(10),
  };
  for (const status of [404, 401, 409]) {
    for (const [name, call] of Object.entries(calls)) {
      const { api } = client([{ status, body: 'TASK_NOT_FOUND' }]);
      await assert.rejects(call(api), (err) => err.rejected === true && err.status === status, `${name} ${status}`);
    }
  }
  const { api } = client([{ status: 400 }]);
  assert.strictEqual(await api.progress('t3', 'VERIFYING'), 400);
});

test('TC-100: jobServer log mỗi request một dòng "{METHOD} {path} task {id} → {status}", không token/query/body', async () => {
  const lines = [];
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-log-'));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const task = '0123456789abcdef0123456789abcdef0123';
  const server = createJobServer({ port, workerToken: FAKE_TOKEN, jobsDir },
    { isReady: () => true, runJob: async () => {}, onUpload: async () => {}, log: (l) => lines.push(l) });
  await server.listen();
  try {
    const base = `http://127.0.0.1:${port}`;
    await fetch(`${base}/chapters/upload?taskId=${task}&index=1`, { method: 'POST', headers: { 'X-Worker-Token': 'sai' } });
    await fetch(`${base}/chapters/upload?taskId=${task}&index=2`, { method: 'POST', headers: { 'X-Worker-Token': FAKE_TOKEN } });
    await fetch(`${base}/jobs?taskId=${task}&fileName=a.pdf`,
      { method: 'POST', headers: { 'X-Worker-Token': FAKE_TOKEN }, body: '%PDF-1.7 bí mật' });
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    server.close();
    fs.rmSync(jobsDir, { recursive: true, force: true });
  }
  const req = lines.filter((l) => / → \d{3}/.test(l));
  assert.ok(req.some((l) => l.startsWith(`POST /chapters/upload task ${task} → 401`)), lines.join('\n'));
  assert.ok(req.some((l) => l.startsWith(`POST /chapters/upload task ${task} → 202`)), lines.join('\n'));
  assert.ok(req.some((l) => l.startsWith(`POST /jobs task ${task} → 202`)), lines.join('\n'));
  for (const l of lines) {
    assert.ok(!l.includes(FAKE_TOKEN) && !l.includes('?') && !l.includes('bí mật'), l);
  }
});
