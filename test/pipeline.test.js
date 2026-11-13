'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { processJob, progressText, spokenText } = require('../src/pipeline');

test('spokenText: đầu chương đọc tên sách + tên chương; Giới thiệu giữ nguyên; Toàn bộ chỉ tên sách (#151)', () => {
  assert.strictEqual(spokenText('Từ tốt đến vĩ đại', { title: 'CHƯƠNG MỘT: TỐT LÀ KẺ THÙ CỦA VĨ ĐẠI', text: 'Nội dung.' }),
    'Từ tốt đến vĩ đại. CHƯƠNG MỘT: TỐT LÀ KẺ THÙ CỦA VĨ ĐẠI.\nNội dung.');
  assert.strictEqual(spokenText('Sách.', { title: 'Chương 2 -', text: 'X' }), 'Sách. Chương 2.\nX');
  assert.strictEqual(spokenText('Sách', { title: 'Giới thiệu', text: 'Bìa' }), 'Bìa');
  assert.strictEqual(spokenText('Sách', { title: 'Toàn bộ', text: 'X' }), 'Sách.\nX');
});

test('progressText: phần trăm chương và tổng, chặn ở 100 (#133)', () => {
  assert.strictEqual(progressText('Chương 2/5', 0.4, 25, 100), 'Chương 2/5 · 40% · tổng 25%');
  assert.strictEqual(progressText('Chương 1/1', 1.2, 0, 0), 'Chương 1/1 · 100% · tổng 0%');
});

test('processJob gửi tiến độ chi tiết khi TTS; lỗi gửi tiến độ không làm hỏng job (#133)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-pipe-'));
  const pdfPath = path.join(dir, 'a.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.7');
  const details = [];
  let completed = false;
  const backend = {
    progress: async (taskId, stage, detail) => {
      details.push(`${stage}|${detail ?? ''}`);
      if (detail && detail.includes('50%')) throw new Error('backend down');
    },
    quotaOk: async () => true,
    complete: async () => { completed = true; },
    failed: async (id, msg) => assert.fail(`không được fail: ${msg}`),
    violation: async () => assert.fail('không được violation'),
  };
  const deps = {
    runScan: async () => null,
    extractText: async () => ({ text: 'Một đoạn văn bản bất kỳ không có tiêu đề chương.', title: 'T', author: null }),
    synthesizeBatch: async (config, items, log, onDone) => {
      log('[tts] chapter 1/1');
      log('[tts] chunk 1/2');
      log('[tts] chunk 2/2');
      fs.writeFileSync(items[0].out, 'mp3');
      onDone(0, { durationSec: 1 });
    },
  };

  await processJob({ taskId: 't1', pdfPath, fileName: 'a.pdf' }, {
    config: { jobsDir: path.join(dir, 'jobs'), cacheDir: path.join(dir, 'cache') },
    backend, uploader: { upload: async () => {} }, log: () => {}, deps,
  });

  assert.ok(completed);
  assert.ok(details.includes('TTS_PROCESSING|Chương 1/1 · 0% · tổng 0%'));
  assert.ok(details.includes('TTS_PROCESSING|Chương 1/1 · 50% · tổng 50%'));
  assert.ok(details.includes('TTS_PROCESSING|Chương 1/1 · 100% · tổng 100%'));
  assert.ok(details.some((d) => d.includes('đang tải audio lên kho lưu trữ')));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** TC-65: job 3 chương qua 1 lần gọi TTS; failAt = vị trí chương (từ 0) mà TTS giả thoát lỗi. */
async function runBatchJob(failAt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-batch-'));
  const pdfPath = path.join(dir, 'a.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.7');
  const out = { calls: 0, details: [], completed: null, failed: null };
  const backend = {
    progress: async (taskId, stage, detail) => { out.details.push(detail ?? ''); },
    quotaOk: async () => true,
    complete: async (id, title, author, chapters) => { out.completed = chapters; },
    failed: async (id, msg) => { out.failed = msg; },
    violation: async () => assert.fail('không được violation'),
  };
  const text = [1, 2, 3].map((n) => `Chương ${n}\n${'Nội dung chương. '.repeat(20)}`).join('\n');
  const deps = {
    runScan: async () => null,
    extractText: async () => ({ text, title: 'Sách', author: null }),
    synthesizeBatch: async (config, items, log, onDone) => {
      out.calls++;
      for (let i = 0; i < items.length; i++) {
        log(`[tts] chapter ${i + 1}/${items.length}`);
        if (i === failAt) throw new Error('TTS thoát mã 1');
        fs.writeFileSync(items[i].out, 'mp3');
        onDone(i, { durationSec: 10 + i });
      }
    },
  };
  await processJob({ taskId: 't3', pdfPath, fileName: 'a.pdf' }, {
    config: { jobsDir: path.join(dir, 'jobs'), cacheDir: path.join(dir, 'cache') },
    backend, uploader: { upload: async () => {} }, log: () => {}, deps,
  });
  out.textDirGone = !fs.existsSync(path.join(dir, 'jobs', 't3'));
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('TC-65: job 3 chương gọi TTS 1 lần, 3 MP3 kèm durationSec, tiến độ Chương i/3', async () => {
  const r = await runBatchJob(-1);
  assert.strictEqual(r.calls, 1);
  assert.strictEqual(r.failed, null);
  assert.deepStrictEqual(r.completed.map((c) => c.durationSec), [10, 11, 12]);
  for (const n of [1, 2, 3]) assert.ok(r.details.some((d) => d.startsWith(`Chương ${n}/3 · 0% · tổng `)));
});

test('TC-65: chương 2 lỗi → FAILED, không complete, dọn file .txt', async () => {
  const r = await runBatchJob(1);
  assert.strictEqual(r.calls, 1);
  assert.strictEqual(r.completed, null);
  assert.strictEqual(r.failed, 'Xử lý thất bại');
  assert.ok(r.textDirGone);
});
