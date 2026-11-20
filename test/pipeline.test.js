'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { processJob, progressText, spokenText, uploadChapter } = require('../src/pipeline');
const { readJob } = require('../src/retryQueue');

test('spokenText: PMO #117 bỏ đầu đề tên sách + tên chương (#151) ở mọi chương, chỉ đọc nội dung', () => {
  assert.strictEqual(spokenText('Từ tốt đến vĩ đại', { title: 'CHƯƠNG MỘT: TỐT LÀ KẺ THÙ CỦA VĨ ĐẠI', text: 'Nội dung.' }),
    'Nội dung.');
  assert.strictEqual(spokenText('Sách.', { title: 'Chương 2 -', text: 'X' }), 'X');
  assert.strictEqual(spokenText('Sách', { title: 'Giới thiệu', text: 'Bìa' }), 'Bìa');
  assert.strictEqual(spokenText('Sách', { title: 'Toàn bộ', text: 'X' }), 'X');
});

test('progressText: phần trăm chương và tổng, chặn ở 100 (#133)', () => {
  assert.strictEqual(progressText('Chương 2/5', 0.4, 25, 100), 'Chương 2/5 · 40% · tổng 25%');
  assert.strictEqual(progressText('Chương 1/1', 1.2, 0, 0), 'Chương 1/1 · 100% · tổng 0%');
});

function tmpJob() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-pipe-'));
  const pdfPath = path.join(dir, 'a.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.7');
  const config = { jobsDir: path.join(dir, 'jobs'), cacheDir: path.join(dir, 'cache') };
  return { dir, pdfPath, config };
}

/** Backend giả ghi lại mọi lời gọi. `chapterDoneFails`: số lần đầu gọi chapterDone ném lỗi mạng. */
function fakeBackend({ chapterDoneFails = 0 } = {}) {
  const out = { progress: [], chapterDone: [], completed: 0, failed: null, violation: null };
  let fails = chapterDoneFails;
  out.api = {
    progress: async (taskId, stage, detail) => { out.progress.push(`${stage}|${detail ?? ''}`); },
    chapterDone: async (taskId, title, author, ch) => {
      out.chapterDone.push(ch.index);
      if (fails-- > 0) throw new Error('backend down');
      return true;
    },
    complete: async () => { out.completed++; },
    failed: async (id, msg) => { out.failed = msg; },
    violation: async (id, v) => { out.violation = v; },
  };
  return out;
}

const THREE = [1, 2, 3].map((n) => `Chương ${n}\n${'Nội dung chương. '.repeat(20)}`).join('\n');
/** FEAT-007 BR-20: tên file (không đuôi) của chương n trong sách THREE. */
const chap = (n) => `00${n} - Chương ${n}`;

/** TTS giả: `failAt(callNo)` = vị trí trong `items` mà lần gọi đó thoát lỗi (-1 = không lỗi). */
function fakeTts(failAt = () => -1) {
  const calls = [];
  const fn = async (config, items, log, onDone) => {
    calls.push({ config, outs: items.map((it) => path.basename(it.out)) });
    const stop = failAt(calls.length);
    for (let i = 0; i < items.length; i++) {
      log(`[tts] chapter ${i + 1}/${items.length}`);
      if (i === stop) throw new Error('TTS thoát mã 1');
      fs.writeFileSync(items[i].out, 'mp3');
      onDone(i, { durationSec: 10 + i });
    }
  };
  return { fn, calls };
}

async function run(job, ctx) {
  const scheduled = [];
  await processJob(job, { log: () => {}, scheduleRetry: (s) => scheduled.push({ ...s }), ...ctx });
  return scheduled;
}

test('processJob gửi tiến độ chi tiết khi TTS; lỗi gửi tiến độ không làm hỏng job (#133)', async () => {
  const { dir, pdfPath, config } = tmpJob();
  const b = fakeBackend();
  const progress = b.api.progress;
  b.api.progress = async (...a) => {
    await progress(...a);
    if (a[2] && a[2].includes('50%')) throw new Error('backend down');
  };
  const deps = {
    runScan: async () => null,
    extractText: async () => ({ text: 'Một đoạn văn bản bất kỳ không có tiêu đề chương.', title: 'T', author: null }),
    synthesizeBatch: async (cfg, items, log, onDone) => {
      log('[tts] chapter 1/1');
      log('[tts] chunk 1/2');
      log('[tts] chunk 2/2');
      fs.writeFileSync(items[0].out, 'mp3');
      onDone(0, { durationSec: 1 });
    },
  };
  await run({ taskId: 't1', pdfPath, fileName: 'a.pdf' }, { config, backend: b.api, deps });

  assert.strictEqual(b.completed, 1);
  assert.ok(b.progress.includes('TTS_PROCESSING|Chương 1/1 · 0% · tổng 0%'));
  assert.ok(b.progress.includes('TTS_PROCESSING|Chương 1/1 · 50% · tổng 50%'));
  assert.ok(b.progress.includes('TTS_PROCESSING|Chương 1/1 · 100% · tổng 100%'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-65/TC-85: job 3 chương gọi TTS 1 lần, báo từng chương, complete, giữ MP3, dọn txt', async () => {
  const { dir, pdfPath, config } = tmpJob();
  const b = fakeBackend();
  const tts = fakeTts();
  const deps = { runScan: async () => null, extractText: async () => ({ text: THREE, title: 'Sách', author: null }),
    synthesizeBatch: tts.fn };
  await run({ taskId: 't3', pdfPath, fileName: 'a.pdf' }, { config, backend: b.api, deps });

  assert.strictEqual(tts.calls.length, 1);
  assert.deepStrictEqual(b.chapterDone, [1, 2, 3]);
  assert.strictEqual(b.completed, 1);
  assert.strictEqual(b.failed, null);
  for (const n of [1, 2, 3]) assert.ok(b.progress.some((d) => d.startsWith(`TTS_PROCESSING|Chương ${n}/3 · 0% · tổng `)));
  assert.ok(fs.existsSync(path.join(config.cacheDir, 't3', `${chap(1)}.mp3`)), 'MP3 phải được giữ (BR-19)');
  // TC-136 (v13): txt chương giữ lâu dài như MP3; chỉ job.json bị xoá khi job kết thúc
  for (const n of [1, 2, 3]) assert.ok(fs.existsSync(path.join(config.jobsDir, 't3', `${chap(n)}.txt`)), `giữ ${n}.txt`);
  assert.ok(!fs.existsSync(path.join(config.jobsDir, 't3', 'job.json')), 'job.json dọn khi job kết thúc');
  assert.ok(!fs.existsSync(pdfPath));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-85: gửi chapter-done lỗi → job chạy tiếp, gửi lại trước complete', async () => {
  const { dir, pdfPath, config } = tmpJob();
  const b = fakeBackend({ chapterDoneFails: 1 });
  const order = [];
  const complete = b.api.complete;
  b.api.complete = async () => { order.push([...b.chapterDone]); await complete(); };
  const deps = { runScan: async () => null, extractText: async () => ({ text: THREE, title: 'Sách', author: null }),
    synthesizeBatch: fakeTts().fn };
  await run({ taskId: 't4', pdfPath, fileName: 'a.pdf' }, { config, backend: b.api, deps });

  assert.deepStrictEqual(b.chapterDone, [1, 2, 3, 1]);
  assert.deepStrictEqual(order, [[1, 2, 3, 1]]);
  assert.strictEqual(b.completed, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-86/TC-77: chương 2 lỗi → RETRYING 1/5/15 phút, chỉ đọc chương còn lại, cấu hình đã chụp, hết lượt → failed', async () => {
  const { dir, pdfPath, config } = tmpJob();
  const b = fakeBackend();
  const tts = fakeTts((callNo) => (callNo === 1 ? 1 : 0)); // lần 1 lỗi ở chương 2, các lần sau lỗi ngay chương đầu
  const deps = { runScan: async () => null, extractText: async () => ({ text: THREE, title: 'Sách', author: null }),
    synthesizeBatch: tts.fn };
  const snap = { speed: 1, pauseMs: 400, voice: 'Thiện Minh', model: '', bitrate: '96k' };
  let scheduled = await run({ taskId: 't5', pdfPath, fileName: 'a.pdf' }, { config, backend: b.api, deps, tts: snap });

  assert.strictEqual(b.failed, null);
  assert.deepStrictEqual(b.chapterDone, [1]);
  assert.ok(b.progress.includes('RETRYING|Đọc tiếp lần 1/3 sau 1 phút'));
  assert.strictEqual(scheduled.length, 1);
  assert.deepStrictEqual(readJob(config.jobsDir, 't5').tts, snap);

  const changed = { ...snap, speed: 1.2 }; // TC-77: đổi cấu hình sau khi job bắt đầu không ảnh hưởng lượt đọc tiếp
  for (const [n, minutes] of [[2, 5], [3, 15]]) {
    scheduled = await run({ taskId: 't5', resume: true }, { config, backend: b.api, deps, tts: changed });
    assert.deepStrictEqual(tts.calls.at(-1).outs, [`${chap(2)}.mp3`, `${chap(3)}.mp3`]);
    assert.strictEqual(tts.calls.at(-1).config.tts.speed, 1);
    assert.ok(b.progress.includes(`RETRYING|Đọc tiếp lần ${n}/3 sau ${minutes} phút`));
    assert.strictEqual(scheduled.length, 1);
  }
  scheduled = await run({ taskId: 't5', resume: true }, { config, backend: b.api, deps });
  assert.strictEqual(scheduled.length, 0);
  assert.match(b.failed, /3 lần/);
  assert.strictEqual(b.completed, 0);
  // TC-136: hết lượt đọc tiếp (FAILED) vẫn giữ txt, chỉ xoá job.json
  assert.ok(!fs.existsSync(path.join(config.jobsDir, 't5', 'job.json')));
  assert.ok(fs.existsSync(path.join(config.jobsDir, 't5', `${chap(3)}.txt`)));
  assert.ok(fs.existsSync(path.join(config.cacheDir, 't5', `${chap(1)}.mp3`)), 'chương đã xong vẫn giữ');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-87/TC-26: vi phạm, không trích được chữ, cấu hình đọc sai → không RETRYING, không gọi TTS', async () => {
  for (const [name, deps, ctxTts, expect] of [
    ['vi phạm', { runScan: async () => '/JavaScript' }, null, (b) => assert.strictEqual(b.violation, '/JavaScript')],
    ['không chữ', { runScan: async () => null, extractText: async () => ({ text: '', title: null, author: null }) }, null,
      (b) => assert.match(b.failed, /Không trích được chữ/)],
    ['cấu hình sai', { runScan: async () => null, extractText: async () => ({ text: THREE, title: 'S', author: null }) },
      { speed: 1.21, pauseMs: 400, voice: 'X', model: '', bitrate: '96k' }, (b) => assert.match(b.failed, /Cấu hình đọc/)],
  ]) {
    const { dir, pdfPath, config } = tmpJob();
    const b = fakeBackend();
    const tts = fakeTts();
    const scheduled = await run({ taskId: 't6', pdfPath, fileName: 'a.pdf' },
      { config, backend: b.api, deps: { ...deps, synthesizeBatch: tts.fn }, tts: ctxTts });
    expect(b);
    assert.strictEqual(scheduled.length, 0, name);
    assert.strictEqual(tts.calls.length, 0, name);
    assert.ok(!b.progress.some((p) => p.startsWith('RETRYING')), name);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-94/TC-27: đẩy chương theo yêu cầu: không có file → missing; R2 lỗi → LOCAL; xong → uploaded, MP3 giữ', async () => {
  const { dir, config } = tmpJob();
  const calls = [];
  const backend = {
    chapterUploaded: async (...a) => calls.push(['ok', ...a]),
    chapterUploadFailed: async (...a) => calls.push(['fail', ...a]),
  };
  const ctx = (upload) => ({ config, backend, uploader: { upload }, log: () => {} });
  await uploadChapter('t7', 1, ctx(async () => assert.fail('không được đẩy')));
  assert.deepStrictEqual(calls.pop(), ['fail', 't7', 1, true]);

  const mp3 = path.join(config.cacheDir, 't7', '1.mp3');
  fs.mkdirSync(path.dirname(mp3), { recursive: true });
  fs.writeFileSync(mp3, 'abc');
  await uploadChapter('t7', 1, ctx(async () => { throw new Error('R2 lỗi 3 lần'); }));
  assert.deepStrictEqual(calls.pop(), ['fail', 't7', 1, false]);

  const keys = [];
  await uploadChapter('t7', 1, ctx(async (key) => keys.push(key)));
  assert.deepStrictEqual(keys, ['books/t7/1.mp3']);
  assert.deepStrictEqual(calls.pop(), ['ok', 't7', 1, 'books/t7/1.mp3', 3]);
  assert.ok(fs.existsSync(mp3));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-144: lỗi I/O sau khi đã ghi txt (saveJob hỏng) → gọi failed, txt còn, không có job.json, PDF bị xoá', async () => {
  const { dir, pdfPath, config } = tmpJob();
  const b = fakeBackend();
  // thư mục trùng tên file tạm của job.json → saveJob ném EISDIR sau khi txt đã ghi xong
  fs.mkdirSync(path.join(config.jobsDir, 't8', 'job.json.tmp'), { recursive: true });
  const tts = fakeTts();
  const deps = { runScan: async () => null, extractText: async () => ({ text: THREE, title: 'Sách', author: null }),
    synthesizeBatch: tts.fn };
  await run({ taskId: 't8', pdfPath, fileName: 'a.pdf' }, { config, backend: b.api, deps });

  assert.strictEqual(b.failed, 'Xử lý thất bại');
  assert.strictEqual(tts.calls.length, 0);
  for (const n of [1, 2, 3]) assert.ok(fs.existsSync(path.join(config.jobsDir, 't8', `${chap(n)}.txt`)), `${n}.txt phải còn`);
  assert.ok(!fs.existsSync(path.join(config.jobsDir, 't8', 'job.json')));
  assert.ok(!fs.existsSync(pdfPath));
  fs.rmSync(dir, { recursive: true, force: true });
});
