'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { processJob } = require('../src/pipeline');
const { readJob } = require('../src/retryQueue');
const { LlmSplitError } = require('../src/extract/llmSplitter');

/** FEAT-007: nhánh tách chương theo cấu hình, thử lại LLM, báo admin (TC-1, TC-11…TC-14, TC-17, TC-18). */

const THREE = [1, 2, 3].map((n) => `Chương ${n}\n${'Nội dung chương. '.repeat(20)}`).join('\n');
const PAGES = ['Trang một nội dung.', 'Trang hai nội dung.', 'Trang ba nội dung.', 'Trang bốn nội dung.'];

function setup({ mode = 'llm', splitResults = [], extract, ollama = { running: true, hasModel: true } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-llm-'));
  const pdfPath = path.join(dir, 'a.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.7');
  const config = { jobsDir: path.join(dir, 'jobs'), cacheDir: path.join(dir, 'cache') };
  const out = { progress: [], chapterDone: [], completed: 0, failed: null, splitCalls: [], admin: [], scheduled: [],
    readyCalls: 0, ttsItems: [] };
  const backend = {
    progress: async (id, stage, detail) => { out.progress.push(`${stage}|${detail ?? ''}`); },
    chapterDone: async (id, title, author, ch) => { out.chapterDone.push(ch.index); return true; },
    complete: async () => { out.completed++; },
    failed: async (id, msg) => { out.failed = msg; },
    violation: async () => {},
  };
  const results = [...splitResults];
  const deps = {
    runScan: async () => null,
    extractText: extract || (async () => ({ text: THREE, pages: PAGES, title: 'Sách A', author: null })),
    splitWithLlm: async (pages, opts) => {
      out.splitCalls.push({ pages, opts });
      const r = results.shift();
      if (r instanceof Error) throw r;
      return r;
    },
    synthesizeBatch: async (cfg, items, log, onDone) => {
      out.ttsItems.push(items.length);
      items.forEach((it, i) => { fs.writeFileSync(it.out, 'mp3'); onDone(i, { durationSec: 1 }); });
    },
    notifyAdmin: async (cfg, payload) => { out.admin.push(payload); },
    ollamaReady: async () => { out.readyCalls++; return ollama; },
  };
  const ctx = {
    config, backend, deps, log: () => {}, split: { mode, model: 'qwen2.5:3b' },
    scheduleRetry: (s) => out.scheduled.push({ ...s }),
  };
  const job = { taskId: 't1', pdfPath, fileName: 'a.pdf' };
  const resume = () => processJob({ taskId: 't1', resume: true }, { ...ctx, split: null });
  const pagesJson = path.join(config.jobsDir, 't1', 'pages.json');
  return { out, ctx, job, resume, config, pdfPath, pagesJson };
}

const LLM_OK = [{ index: 1, title: 'Phần 1', text: 'Trang một nội dung.\nTrang hai nội dung.' },
  { index: 2, title: 'Phần 2', text: 'Trang ba nội dung.\nTrang bốn nội dung.' }];

test('TC-1: mode heuristic → splitChapters như cũ, không gọi Ollama/LLM', async () => {
  const { out, ctx, job } = setup({ mode: 'heuristic' });
  await processJob(job, ctx);
  assert.strictEqual(out.splitCalls.length, 0);
  assert.strictEqual(out.readyCalls, 0);
  assert.deepStrictEqual(out.chapterDone, [1, 2, 3]);
  assert.strictEqual(out.completed, 1);
});

test('AC-2: mode llm thành công → chương theo LLM, TTS + báo chương chạy như cũ, dọn pages.json', async () => {
  const { out, ctx, job, config, pdfPath, pagesJson } = setup({ splitResults: [LLM_OK] });
  await processJob(job, ctx);
  assert.deepStrictEqual(out.splitCalls[0].pages, PAGES);
  assert.strictEqual(out.splitCalls[0].opts.model, 'qwen2.5:3b');
  assert.deepStrictEqual(out.chapterDone, [1, 2]);
  assert.strictEqual(out.completed, 1);
  assert.ok(fs.readFileSync(path.join(config.jobsDir, 't1', '1.txt'), 'utf8').startsWith('Sách A. Phần 1.\n'));
  assert.ok(!fs.existsSync(pdfPath));
  assert.ok(!fs.existsSync(pagesJson));
  assert.strictEqual(readJob(config.jobsDir, 't1'), null);
});

test('TC-10/TC-11/TC-13: lỗi 1, 2, 3 → hẹn 1/5/15 phút từ pages.json; lượt 3 lỗi → failed, báo admin 1 lần, '
  + 'không chạy heuristic', async () => {
  const err = () => new LlmSplitError('Gọi Ollama lỗi: connect ECONNREFUSED');
  const { out, ctx, job, resume, config, pdfPath, pagesJson } = setup({ splitResults: [err(), err(), err(), err()] });
  await processJob(job, ctx);
  assert.ok(!fs.existsSync(pdfPath), 'PDF bị xoá, lượt sau đọc pages.json');
  assert.ok(fs.existsSync(pagesJson));
  assert.strictEqual(out.scheduled[0].splitAttempt, 1);
  assert.strictEqual(readJob(config.jobsDir, 't1').phase, 'split');

  await resume();
  await resume();
  assert.deepStrictEqual(out.scheduled.map((s) => s.splitAttempt), [1, 2, 3]);
  assert.deepStrictEqual(out.progress.filter((p) => p.startsWith('RETRYING')).map((p) => p.split(' sau ')[1]),
    ['1 phút', '5 phút', '15 phút']);
  assert.strictEqual(out.failed, null);
  assert.ok(out.splitCalls.every((c) => c.pages.length === PAGES.length));

  await resume();
  assert.strictEqual(out.splitCalls.length, 4);
  assert.strictEqual(out.scheduled.length, 3);
  assert.match(out.failed, /Tách chương lỗi, đã thử lại 3 lần/);
  assert.deepStrictEqual(out.chapterDone, [], 'không chuyển sang heuristic');
  assert.strictEqual(out.completed, 0);
  assert.strictEqual(out.admin.length, 1);
  assert.strictEqual(out.admin[0].taskId, 't1');
  assert.strictEqual(out.admin[0].model, 'qwen2.5:3b');
  assert.strictEqual(out.admin[0].attempts, 3);
  assert.strictEqual(out.admin[0].bookTitle, 'Sách A');
  assert.match(out.admin[0].error, /ECONNREFUSED/);
  assert.ok(!('pages' in out.admin[0]) && !JSON.stringify(out.admin[0]).includes('Trang một'), 'không gửi nội dung sách');
  assert.ok(!fs.existsSync(pagesJson));
  assert.strictEqual(readJob(config.jobsDir, 't1'), null);
});

test('TC-12: lỗi lần 1, lượt 2 thành công → chạy TTS, không báo admin, dọn pages.json, TTS còn đủ lượt đọc tiếp', async () => {
  const { out, ctx, job, resume, config, pagesJson } = setup({ splitResults: [new LlmSplitError('JSON hỏng'), LLM_OK] });
  await processJob(job, ctx);
  await resume();
  assert.strictEqual(out.completed, 1);
  assert.deepStrictEqual(out.chapterDone, [1, 2]);
  assert.strictEqual(out.admin.length, 0);
  assert.strictEqual(out.failed, null);
  assert.ok(!fs.existsSync(pagesJson));
  assert.strictEqual(readJob(config.jobsDir, 't1'), null);
});

test('TC-14: heuristic lỗi (trích chữ ném lỗi / PDF không có chữ) → failed như cũ, không báo admin', async () => {
  const a = setup({ mode: 'heuristic', extract: async () => { throw new Error('pdf hỏng'); } });
  await processJob(a.job, a.ctx);
  assert.strictEqual(a.out.failed, 'Xử lý thất bại');
  assert.strictEqual(a.out.admin.length, 0);

  const b = setup({ mode: 'heuristic', extract: async () => ({ text: '', pages: [''], title: null, author: null }) });
  await processJob(b.job, b.ctx);
  assert.match(b.out.failed, /Không trích được chữ/);
  assert.strictEqual(b.out.admin.length, 0);
});

test('TC-17: chưa chọn mode, Ollama chạy + có model → llm', async () => {
  const { out, ctx, job } = setup({ mode: '', splitResults: [LLM_OK] });
  await processJob(job, ctx);
  assert.strictEqual(out.readyCalls, 1);
  assert.strictEqual(out.splitCalls.length, 1);
  assert.deepStrictEqual(out.chapterDone, [1, 2]);
});

test('TC-18: chưa chọn mode, Ollama không chạy hoặc thiếu model → heuristic', async () => {
  for (const ollama of [{ running: false, hasModel: false }, { running: true, hasModel: false }]) {
    const { out, ctx, job } = setup({ mode: '', ollama });
    await processJob(job, ctx);
    assert.strictEqual(out.splitCalls.length, 0);
    assert.deepStrictEqual(out.chapterDone, [1, 2, 3]);
  }
});
