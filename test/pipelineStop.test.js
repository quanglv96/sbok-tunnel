'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { processJob, uploadChapter } = require('../src/pipeline');
const { createRetryQueue, saveJob } = require('../src/retryQueue');

const THREE = [1, 2, 3].map((n) => `Chương ${n}\n${'Nội dung chương. '.repeat(20)}`).join('\n');

/** Lỗi backendClient ném khi backend trả 404/401/409 (BR-22). */
function rejected(status) {
  return Object.assign(new Error(`backend HTTP ${status}`), { rejected: true, status });
}

function tmpJob() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-stop-'));
  const pdfPath = path.join(dir, 'a.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.7');
  return { dir, pdfPath, config: { jobsDir: path.join(dir, 'jobs'), cacheDir: path.join(dir, 'cache') } };
}

/** `failOn(name, args)` trả lỗi cần ném cho lời gọi đó (hoặc undefined). Mọi lời gọi ghi vào `calls`. */
function backend(failOn) {
  const calls = [];
  const wrap = (name, ret) => async (...args) => {
    calls.push(name === 'progress' ? `progress:${args[1]}` : name);
    const err = failOn(name, args);
    if (err) throw err;
    return ret;
  };
  return {
    calls,
    api: {
      progress: wrap('progress'), chapterDone: wrap('chapterDone', true), complete: wrap('complete'),
      failed: wrap('failed'), violation: wrap('violation'),
      chapterUploaded: wrap('chapterUploaded'), chapterUploadFailed: wrap('chapterUploadFailed'),
    },
  };
}

/** TTS giả nhả từng chương qua một vòng event loop; dừng khi `signal` bị huỷ. */
function fakeTts() {
  const calls = [];
  const fn = async (config, items, log, onDone, signal) => {
    calls.push(items.map((it) => path.basename(it.out)));
    for (let i = 0; i < items.length; i++) {
      await new Promise((r) => setImmediate(r));
      if (signal && signal.aborted) throw new Error('đã dừng');
      log(`[tts] chapter ${i + 1}/${items.length}`);
      fs.writeFileSync(items[i].out, 'mp3');
      onDone(i, { durationSec: 1 });
      await new Promise((r) => setImmediate(r));
    }
  };
  return { fn, calls };
}

async function runCase(failOn) {
  const { dir, pdfPath, config } = tmpJob();
  const b = backend(failOn);
  const tts = fakeTts();
  const scheduled = [];
  const cancelled = [];
  const logs = [];
  await processJob({ taskId: 't9', pdfPath, fileName: 'a.pdf' }, {
    config, backend: b.api, log: (l) => logs.push(l),
    deps: { runScan: async () => null, extractText: async () => ({ text: THREE, title: 'Sách', author: null }),
      synthesizeBatch: tts.fn },
    scheduleRetry: (s) => scheduled.push(s), cancelRetry: (id) => cancelled.push(id),
  });
  return { dir, config, pdfPath, b, tts, scheduled, cancelled, logs };
}

const txt = (config, n) => path.join(config.jobsDir, 't9', `${n}.txt`);
const jobJson = (config) => path.join(config.jobsDir, 't9', 'job.json');

for (const status of [404, 401, 409]) {
  test(`TC-99/TC-135: progress(VERIFYING) ${status} → dừng ngay, không quét, không gọi failed`, async () => {
    const r = await runCase((name, a) => (name === 'progress' && a[1] === 'VERIFYING' ? rejected(status) : undefined));
    assert.deepStrictEqual(r.b.calls, ['progress:VERIFYING']);
    assert.strictEqual(r.tts.calls.length, 0);
    assert.strictEqual(r.scheduled.length, 0);
    assert.ok(!fs.existsSync(r.pdfPath), 'PDF tạm vẫn bị xoá');
    assert.strictEqual(r.logs.filter((l) => l.includes(String(status)) && /dừng/i.test(l)).length, 1, r.logs.join('\n'));
    fs.rmSync(r.dir, { recursive: true, force: true });
  });

  test(`TC-99/TC-135: progress(TTS_PROCESSING) ${status} → không TTS, không callback khác, txt giữ, job.json xoá`, async () => {
    const r = await runCase((name, a) => (name === 'progress' && a[1] === 'TTS_PROCESSING' ? rejected(status) : undefined));
    assert.strictEqual(r.tts.calls.length, 0);
    assert.deepStrictEqual(r.b.calls.filter((c) => !c.startsWith('progress:')), []);
    assert.ok(!r.b.calls.includes('progress:RETRYING'));
    assert.strictEqual(r.scheduled.length, 0);
    assert.ok(fs.existsSync(txt(r.config, 1)) && fs.existsSync(txt(r.config, 3)), 'txt chương giữ nguyên');
    assert.ok(!fs.existsSync(jobJson(r.config)), 'job.json bị xoá');
    fs.rmSync(r.dir, { recursive: true, force: true });
  });

  test(`TC-99/TC-135: chapterDone ${status} → dừng TTS, không gửi chương sau/complete/failed, MP3 + txt giữ`, async () => {
    const r = await runCase((name) => (name === 'chapterDone' ? rejected(status) : undefined));
    assert.strictEqual(r.b.calls.filter((c) => c === 'chapterDone').length, 1);
    for (const c of ['complete', 'failed', 'progress:RETRYING']) assert.ok(!r.b.calls.includes(c), c);
    assert.strictEqual(r.scheduled.length, 0);
    assert.ok(fs.existsSync(path.join(r.config.cacheDir, 't9', '1.mp3')), 'MP3 đã có giữ nguyên');
    assert.ok(!fs.existsSync(path.join(r.config.cacheDir, 't9', '3.mp3')), 'không TTS tiếp');
    assert.ok(fs.existsSync(txt(r.config, 2)));
    assert.ok(!fs.existsSync(jobJson(r.config)));
    fs.rmSync(r.dir, { recursive: true, force: true });
  });

  test(`TC-99/TC-135: complete ${status} → không failed, không đọc tiếp, txt giữ, job.json xoá`, async () => {
    const r = await runCase((name) => (name === 'complete' ? rejected(status) : undefined));
    for (const c of ['failed', 'progress:RETRYING']) assert.ok(!r.b.calls.includes(c), c);
    assert.strictEqual(r.scheduled.length, 0);
    assert.ok(fs.existsSync(txt(r.config, 1)));
    assert.ok(!fs.existsSync(jobJson(r.config)));
    fs.rmSync(r.dir, { recursive: true, force: true });
  });
}

test('TC-99: lỗi không phải rejected (400 trả về, 500/lỗi mạng ném lỗi thường) → xử lý như BR-18', async () => {
  // chapterDone lỗi mạng: job chạy tiếp, gửi lại trước complete
  let n = 0;
  const r = await runCase((name) => (name === 'chapterDone' && n++ === 0 ? new Error('backend HTTP 500') : undefined));
  assert.ok(r.b.calls.includes('complete'));
  assert.ok(!r.b.calls.includes('failed'));
  fs.rmSync(r.dir, { recursive: true, force: true });

  // progress(VERIFYING) lỗi thường → failed như cũ
  const r2 = await runCase((name, a) => (name === 'progress' && a[1] === 'VERIFYING' ? new Error('ECONNREFUSED') : undefined));
  assert.ok(r2.b.calls.includes('failed'));
  fs.rmSync(r2.dir, { recursive: true, force: true });
});

test('TC-135: chapter-uploaded/chapter-upload-failed bị từ chối → huỷ hẹn đọc tiếp, xoá job.json, MP3 + txt giữ', async () => {
  const { dir, config } = tmpJob();
  const mp3 = path.join(config.cacheDir, 't9', '1.mp3');
  fs.mkdirSync(path.dirname(mp3), { recursive: true });
  fs.writeFileSync(mp3, 'abc');
  saveJob(config.jobsDir, { taskId: 't9', chapters: [{ index: 1 }], done: {}, reported: [], attempt: 1,
    nextRetryAt: new Date(Date.now() + 60_000).toISOString() });
  fs.writeFileSync(txt(config, 1), 'chữ');
  const b = backend((name) => (name === 'chapterUploaded' ? rejected(404) : undefined));
  const cancelled = [];
  await uploadChapter('t9', 1, { config, backend: b.api, uploader: { upload: async () => {} }, log: () => {},
    cancelRetry: (id) => cancelled.push(id) });
  assert.deepStrictEqual(cancelled, ['t9']);
  assert.ok(!fs.existsSync(jobJson(config)));
  assert.ok(fs.existsSync(mp3) && fs.existsSync(txt(config, 1)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-135: retryQueue.cancel huỷ hẹn và xoá job.json, giữ txt', () => {
  const { dir, config } = tmpJob();
  saveJob(config.jobsDir, { taskId: 't9', chapters: [], done: {}, reported: [], attempt: 1,
    nextRetryAt: new Date(Date.now() + 60_000).toISOString() });
  fs.writeFileSync(txt(config, 1), 'chữ');
  const cleared = [];
  const enqueued = [];
  const q = createRetryQueue({ jobsDir: config.jobsDir, enqueue: (j) => enqueued.push(j), log: () => {},
    setTimer: () => 'timer-1' });
  const realClear = global.clearTimeout;
  global.clearTimeout = (t) => cleared.push(t);
  try {
    assert.strictEqual(q.load(), 1);
    q.cancel('t9');
  } finally {
    global.clearTimeout = realClear;
  }
  assert.ok(cleared.includes('timer-1'), 'timer bị huỷ');
  assert.ok(!fs.existsSync(jobJson(config)));
  assert.ok(fs.existsSync(txt(config, 1)));
  assert.strictEqual(enqueued.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
