'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { processJob, progressText } = require('../src/pipeline');

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
    synthesize: async (config, txt, mp3, log) => {
      log('[tts] chunk 1/2');
      log('[tts] chunk 2/2');
      fs.writeFileSync(mp3, 'mp3');
      return { durationSec: 1 };
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
