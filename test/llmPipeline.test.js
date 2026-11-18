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

const STATS = { prompt_eval_count: 812, eval_count: 37, firstByteMs: 321000, totalMs: 330000, pages: 4, promptChars: 90,
  numCtx: 16384 };

function setup({ mode = 'llm', source = 'ui', splitResults = [], extract, ollama = { running: true, hasModel: true } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-llm-'));
  const pdfPath = path.join(dir, 'a.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.7');
  const config = { jobsDir: path.join(dir, 'jobs'), cacheDir: path.join(dir, 'cache') };
  const out = { progress: [], chapterDone: [], completed: 0, failed: null, splitCalls: [], admin: [], scheduled: [],
    readyCalls: 0, ttsItems: [], logs: [] };
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
      if (typeof r === 'function') return r(pages, opts);
      if (r instanceof Error) throw r;
      return { chapters: r, stats: STATS };
    },
    synthesizeBatch: async (cfg, items, log, onDone) => {
      out.ttsItems.push(items.length);
      items.forEach((it, i) => { fs.writeFileSync(it.out, 'mp3'); onDone(i, { durationSec: 1 }); });
    },
    notifyAdmin: async (cfg, payload) => { out.admin.push(payload); },
    ollamaReady: async () => { out.readyCalls++; return ollama; },
  };
  const ctx = {
    config, backend, deps, log: (l) => out.logs.push(l), split: { mode, model: 'qwen2.5:3b', source },
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

test('TC-32: Ollama cổng đóng → log hẹn thử lại chứa mã ECONNREFUSED', async () => {
  const { splitWithLlm } = require('../src/extract/llmSplitter');
  const refused = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
  const real = (pages, opts) => splitWithLlm(pages, { ...opts, chatFn: async () => { throw refused; } });
  const { out, ctx, job } = setup({ splitResults: [real] });
  await processJob(job, ctx);
  assert.ok(out.logs.some((l) => /thử lại lần 1\/3/.test(l) && l.includes('ECONNREFUSED')), out.logs.join('\n'));
  assert.ok(out.logs.some((l) => /\[tách chương LLM .*\] lỗi \(\d+ ms\): .*ECONNREFUSED/.test(l)));
});

/** Mỗi tên bước có dòng bắt đầu và dòng xong kèm ms (AC-14). */
function assertStep(logs, name, extraRe) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.ok(logs.some((l) => new RegExp(`\\[${esc}[^\\]]*\\] bắt đầu`).test(l)), `thiếu bắt đầu: ${name}\n${logs.join('\n')}`);
  const done = logs.find((l) => new RegExp(`\\[${esc}[^\\]]*\\] xong \\(\\d+ ms`).test(l));
  assert.ok(done, `thiếu xong: ${name}\n${logs.join('\n')}`);
  if (extraRe) assert.match(done, extraRe);
}

test('TC-35: job heuristic → log bắt đầu/xong + ms từng bước, mỗi chương TTS, báo chương', async () => {
  const { out, ctx, job } = setup({ mode: 'heuristic', source: 'env' });
  await processJob(job, ctx);
  assertStep(out.logs, 'kiểm tra an toàn', /qua/);
  assertStep(out.logs, 'trích chữ', /4 trang, \d+ ký tự/);
  assert.ok(out.logs.some((l) => /\[chọn chế độ\] xong \(\d+ ms, heuristic, nguồn env\)/.test(l)));
  assertStep(out.logs, 'tách chương heuristic', /3 chương/);
  assertStep(out.logs, 'ghi txt + job.json', /3 chương, \d+ ký tự/);
  for (const i of [1, 2, 3]) {
    assert.ok(out.logs.some((l) => new RegExp(`\\[TTS chương ${i}/3\\] xong \\(\\d+ ms, \\d+ ký tự\\)`).test(l)), out.logs.join('\n'));
    assert.ok(out.logs.some((l) => new RegExp(`\\[báo chương ${i}\\] xong \\(\\d+ ms, nhận\\)`).test(l)));
  }
  assertStep(out.logs, 'báo hoàn tất');
});

test('TC-36: job llm → log chế độ + nguồn, model, số trang, promptChars, numCtx, firstByteMs, totalMs, eval count, số chương',
  async () => {
    const { out, ctx, job } = setup({ splitResults: [LLM_OK], source: 'ui' });
    await processJob(job, ctx);
    assert.ok(out.logs.some((l) => /\[chọn chế độ\] xong \(\d+ ms, llm, nguồn ui\)/.test(l)));
    assertStep(out.logs, 'tách chương LLM qwen2.5:3b, lần đầu', new RegExp('4 trang, promptChars 90, numCtx 16384, '
      + 'firstByteMs 321000, totalMs 330000, prompt_eval_count 812, eval_count 37, 2 chương'));

    const auto = setup({ mode: '', splitResults: [LLM_OK] });
    await processJob(auto.job, auto.ctx);
    assert.ok(auto.out.logs.some((l) => /\[chọn chế độ\] xong \(\d+ ms, llm, tự động: running=true, hasModel=true\)/.test(l)));
  });

test('TC-37: không dòng log nào chứa text trang hay API key', async () => {
  const SECRET = 'NOI-DUNG-BI-MAT-xyz';
  const KEY = 'api-key-khong-duoc-log';
  for (const mode of ['llm', 'heuristic']) {
    const pages = [`Chương 1 ${SECRET}`, 'Trang hai', 'Chương 2 nữa', 'Trang bốn'];
    const { out, ctx, job } = setup({ mode, splitResults: [new LlmSplitError('JSON hỏng')],
      extract: async () => ({ text: pages.join('\n'), pages, title: 'Sách', author: null }) });
    ctx.config.adminApiKey = KEY;
    ctx.config.adminAlertUrl = 'https://admin.example';
    await processJob(job, ctx);
    assert.ok(out.logs.length > 3);
    assert.ok(out.logs.every((l) => !l.includes(SECRET) && !l.includes(KEY)), out.logs.join('\n'));
  }
});

test('TC-18: chưa chọn mode, Ollama không chạy hoặc thiếu model → heuristic', async () => {
  for (const ollama of [{ running: false, hasModel: false }, { running: true, hasModel: false }]) {
    const { out, ctx, job } = setup({ mode: '', ollama });
    await processJob(job, ctx);
    assert.strictEqual(out.splitCalls.length, 0);
    assert.deepStrictEqual(out.chapterDone, [1, 2, 3]);
  }
});
