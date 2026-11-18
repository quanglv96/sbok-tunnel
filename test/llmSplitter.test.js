'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { LlmSplitError, buildPrompt, splitWithLlm } = require('../src/extract/llmSplitter');
const { chat, isReady, pull } = require('../src/ollama');

const PAGES = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const reply = (obj) => async () => (typeof obj === 'string' ? obj : JSON.stringify(obj));
const split = (content, pages = PAGES) => splitWithLlm(pages, { model: 'qwen2.5:3b', chatFn: reply(content) });

test('TC-2: 2 chương start_page 1/4 trên 6 trang → C1 = trang 1-3, C2 = trang 4-6', async () => {
  const chapters = await split({ chapters: [{ title: 'C1', start_page: 1 }, { title: 'C2', start_page: 4 }] });
  assert.deepStrictEqual(chapters, [
    { index: 1, title: 'C1', text: 'p1\np2\np3' },
    { index: 2, title: 'C2', text: 'p4\np5\np6' },
  ]);
});

test('TC-3: chương cuối start_page = số trang → 1 trang; nhận cả mảng trần', async () => {
  const chapters = await split([{ title: 'C1', start_page: 1 }, { title: 'Cuối', start_page: 6 }]);
  assert.strictEqual(chapters[1].text, 'p6');
  assert.strictEqual(chapters[0].text, 'p1\np2\np3\np4\np5');
});

test('TC-4: 1 chương start_page 1 → cả sách 1 chương', async () => {
  const chapters = await split({ chapters: [{ title: 'Toàn bộ', start_page: 1 }] });
  assert.deepStrictEqual(chapters, [{ index: 1, title: 'Toàn bộ', text: PAGES.join('\n') }]);
});

test('chương đầu bắt đầu sau trang 1 → các trang trước thành "Giới thiệu"', async () => {
  const chapters = await split({ chapters: [{ title: 'C1', start_page: 3 }] });
  assert.deepStrictEqual(chapters.map((c) => [c.title, c.text]), [['Giới thiệu', 'p1\np2'], ['C1', 'p3\np4\np5\np6']]);
});

const rejects = (content, re) => assert.rejects(split(content), (err) => err instanceof LlmSplitError && re.test(err.message));

test('TC-5: JSON hỏng / không có danh sách chương → LlmSplitError', async () => {
  await rejects('không phải json', /không phải JSON/);
  await rejects({ x: 1 }, /không có danh sách/);
});

test('TC-6: danh sách rỗng → LlmSplitError', async () => {
  await rejects([], /rỗng/);
  await rejects({ chapters: [] }, /rỗng/);
});

test('TC-7: start_page 0, > số trang hoặc không phải số nguyên → LlmSplitError', async () => {
  await rejects([{ title: 'A', start_page: 0 }], /ngoài/);
  await rejects([{ title: 'A', start_page: 7 }], /ngoài/);
  await rejects([{ title: 'A', start_page: 1.5 }], /ngoài/);
  await rejects([{ title: 'A' }], /ngoài/);
});

test('TC-8: start_page trùng hoặc giảm → LlmSplitError', async () => {
  await rejects([{ title: 'A', start_page: 1 }, { title: 'B', start_page: 4 }, { title: 'C', start_page: 4 }], /tăng dần/);
  await rejects([{ title: 'A', start_page: 1 }, { title: 'B', start_page: 4 }, { title: 'C', start_page: 2 }], /tăng dần/);
});

test('TC-9: tiêu đề rỗng → LlmSplitError', async () => {
  await rejects([{ title: '  ', start_page: 1 }], /tiêu đề rỗng/);
});

test('TC-10: Ollama timeout / ECONNREFUSED / thiếu bộ nhớ → LlmSplitError (được thử lại)', async () => {
  for (const msg of ['connect ECONNREFUSED 127.0.0.1:11434', 'The operation was aborted due to timeout',
    'model requires more system memory (5.6 GiB) than is available', 'bad allocation']) {
    await assert.rejects(splitWithLlm(PAGES, { model: 'm', chatFn: async () => { throw new Error(msg); } }),
      (err) => err instanceof LlmSplitError && err.message.includes(msg));
  }
  await assert.rejects(splitWithLlm([], { model: 'm', chatFn: reply([]) }), LlmSplitError);
});

test('buildPrompt: đánh số trang, sách dài thì cắt mỗi trang ngắn hơn (vừa ngữ cảnh model 3b)', () => {
  assert.strictEqual(buildPrompt(['Chương 1\n  Mở đầu', 'b']), '[Trang 1] Chương 1 Mở đầu\n[Trang 2] b');
  const long = buildPrompt(Array.from({ length: 1000 }, () => 'x'.repeat(500)));
  assert.ok(long.length < 1000 * 60);
  assert.ok(long.startsWith(`[Trang 1] ${'x'.repeat(40)}\n`));
});

const fakeRes = (status, body) => ({ ok: status < 300, status, text: async () => body, json: async () => JSON.parse(body) });

test('ollama.chat ghép nội dung stream; dòng error → ném lỗi; HTTP lỗi → ném lỗi', async () => {
  let sent;
  const ndjson = ['{"message":{"content":"{\\"chapters\\":"}}', '{"message":{"content":"[]}"},"done":true}'].join('\n');
  const content = await chat('qwen2.5:3b', [{ role: 'user', content: 'x' }], {
    fetchFn: async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return fakeRes(200, ndjson); },
  });
  assert.strictEqual(content, '{"chapters":[]}');
  assert.ok(sent.url.endsWith('/api/chat'));
  assert.strictEqual(sent.body.format, 'json');
  await assert.rejects(chat('m', [], { fetchFn: async () => fakeRes(200, '{"error":"model requires more system memory"}') }),
    /more system memory/);
  await assert.rejects(chat('m', [], { fetchFn: async () => fakeRes(500, 'boom') }), /HTTP 500/);
});

test('ollama.isReady / pull: có model theo tên hoặc :latest; lỗi kết nối = không chạy; pull báo success', async () => {
  const tags = JSON.stringify({ models: [{ name: 'qwen2.5:3b' }, { name: 'llama3:latest' }] });
  assert.deepStrictEqual(await isReady('qwen2.5:3b', { fetchFn: async () => fakeRes(200, tags) }), { running: true, hasModel: true });
  assert.deepStrictEqual(await isReady('llama3', { fetchFn: async () => fakeRes(200, tags) }), { running: true, hasModel: true });
  assert.deepStrictEqual(await isReady('qwen2.5:7b', { fetchFn: async () => fakeRes(200, tags) }), { running: true, hasModel: false });
  assert.deepStrictEqual(await isReady('m', { fetchFn: async () => { throw new Error('ECONNREFUSED'); } }),
    { running: false, hasModel: false });
  await pull('m', { fetchFn: async () => fakeRes(200, '{"status":"pulling"}\n{"status":"success"}') });
  await assert.rejects(pull('m', { fetchFn: async () => fakeRes(200, '{"error":"file does not exist"}') }), /does not exist/);
});
