'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { LlmSplitError, buildPrompt, fullTitle, headingLines, parseChapters, splitWithLlm } = require('../src/extract/llmSplitter');
const { NUM_CTX, isReady, pull } = require('../src/ollama');

const PAGES = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const STATS = { prompt_eval_count: 900, eval_count: 40, firstByteMs: 1200, totalMs: 1500 };
const reply = (obj) => async () => ({ content: typeof obj === 'string' ? obj : JSON.stringify(obj), stats: STATS });
const split = async (content, pages = PAGES) =>
  (await splitWithLlm(pages, { model: 'qwen2.5:3b', chatFn: reply(content) })).chapters;

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

test('TC-50: không trang nào có tiêu đề → prompt cũ (phần đầu trang), sách dài cắt mỗi trang ngắn hơn', () => {
  assert.strictEqual(buildPrompt(['mở đầu\n  nội dung', 'b']), '[Trang 1] mở đầu nội dung\n[Trang 2] b');
  const long = buildPrompt(Array.from({ length: 1000 }, () => 'x'.repeat(500)));
  assert.ok(long.length < 1000 * 60);
  assert.ok(long.startsWith(`[Trang 1] ${'x'.repeat(40)}\n`));
});

test('TC-32: lỗi socket chỉ có mã trong err.code / err.cause.code → message LlmSplitError chứa mã', async () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
  await assert.rejects(splitWithLlm(PAGES, { model: 'm', chatFn: async () => { throw refused; } }),
    (err) => err instanceof LlmSplitError && err.message === 'Gọi Ollama lỗi: connect ECONNREFUSED 127.0.0.1:11434');
  const undici = new TypeError('fetch failed', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
  await assert.rejects(splitWithLlm(PAGES, { model: 'm', chatFn: async () => { throw undici; } }),
    (err) => err instanceof LlmSplitError && err.message === 'Gọi Ollama lỗi: fetch failed (UND_ERR_HEADERS_TIMEOUT)');
});

test('TC-34: splitWithLlm trả kèm số liệu chat + số trang, độ dài prompt, numCtx (không chứa text trang)', async () => {
  const r = await splitWithLlm(PAGES, { model: 'm', chatFn: reply([{ title: 'C1', start_page: 1 }]) });
  assert.deepStrictEqual(r.stats,
    { ...STATS, pages: 6, headingPages: 0, promptChars: buildPrompt(PAGES).length, numCtx: NUM_CTX });
  assert.ok(!JSON.stringify(r.stats).includes('p1'));
});

test('TC-44: tiêu đề chương bị xuống dòng do khổ giấy → title đầy đủ (LLM chỉ trả dòng đầu)', async () => {
  const pages = ['Mục lục', 'CHƯƠNG BỐN: ĐỐI MẶT SỰ THẬT\nPHŨ PHÀNG (NHƯNG ĐỪNG\nMẤT NIỀM TIN)\nThân bài bình thường.', 'x'];
  const chapters = await split({ chapters: [{ title: 'Chương bốn: Đối mặt sự thật', start_page: 2 }] }, pages);
  assert.strictEqual(chapters[1].title, 'CHƯƠNG BỐN: ĐỐI MẶT SỰ THẬT PHŨ PHÀNG (NHƯNG ĐỪNG MẤT NIỀM TIN)');
  assert.strictEqual(chapters[1].text, pages.slice(1).join('\n'));
});

test('TC-45: ghép tiêu đề sau ":" / ngoặc chưa đóng; không ghép thân bài, không khớp nhầm CHƯƠNG 1 với CHƯƠNG 10', () => {
  assert.deepStrictEqual(headingLines('Chương 1:\nMở đầu\nNội dung chương.'), ['Chương 1: Mở đầu']);
  assert.deepStrictEqual(headingLines('Phụ lục A (bảng tra\ncứu thuật ngữ)\nNội dung.'), ['Phụ lục A (bảng tra cứu thuật ngữ)']);
  assert.deepStrictEqual(headingLines('PHỤ LỤC A\nBảng tra cứu thuật ngữ dùng trong sách.'), ['PHỤ LỤC A']);
  assert.strictEqual(fullTitle('CHƯƠNG 1', 'CHƯƠNG 10: KẾT\nThân bài.'), 'CHƯƠNG 1');
  assert.strictEqual(fullTitle('Giới thiệu', 'Giới thiệu về tác giả và cuốn sách này'), 'Giới thiệu');
  assert.strictEqual(fullTitle('C1', undefined), 'C1');
});

test('TC-46: không ghép khi dòng sau bắt đầu bằng từ khoá; header chạy đầu trang không nuốt tiêu đề chương', () => {
  assert.deepStrictEqual(headingLines('PHẦN I\nCHƯƠNG 1: MỞ ĐẦU'), ['PHẦN I', 'CHƯƠNG 1: MỞ ĐẦU']);
  assert.strictEqual(fullTitle('Chương 4', 'TÊN SÁCH\nCHƯƠNG 4: X\nthân bài'), 'CHƯƠNG 4: X');
});

test('TC-47: prompt chỉ có [Trang N] + dòng tiêu đề, bỏ trang chỉ có thân bài, không chứa thân bài', async () => {
  const pages = ['bìa sách', 'CHƯƠNG 1: A\nnội dung BODYMARK', 'chỉ thân bài BODYMARK2', 'x', 'y'];
  assert.strictEqual(buildPrompt(pages), '[Trang 2] CHƯƠNG 1: A');
  const r = await splitWithLlm(pages, { model: 'm', chatFn: reply([{ title: 'C1', start_page: 2 }]) });
  assert.strictEqual(r.stats.headingPages, 1);
});

test('TC-48: trang mục lục gửi nguyên văn; tiêu đề xuống dòng gửi dạng đã ghép', () => {
  const pages = ['MỤC LỤC\nChương 1 …… 5\n  Chương 2 …… 9', 'CHƯƠNG 1:\nMỞ ĐẦU\nthân bài'];
  assert.strictEqual(buildPrompt(pages), '[Trang 1]\nMỤC LỤC\nChương 1 …… 5\nChương 2 …… 9\n[Trang 2] CHƯƠNG 1: MỞ ĐẦU');
});

test('TC-49: 338 trang tiêu đề dài + mục lục dài → ≤ 30 000 ký tự, cắt theo ranh giới trang', () => {
  const toc = ['Mục lục', ...Array.from({ length: 338 }, (_, i) => `Chương ${i + 1} ........ ${i + 2}`)].join('\n');
  const pages = [toc, ...Array.from({ length: 337 }, (_, i) => `CHƯƠNG ${i + 2}: ${'A'.repeat(100)}\nthân bài`)];
  const p = buildPrompt(pages);
  assert.ok(p.length <= 30_000 && p.length > 25_000);
  assert.ok(p.startsWith('[Trang 1]\nMục lục\nChương 1 '));
  assert.match(p.split('\n').pop(), /^\[Trang \d+\] CHƯƠNG \d+: A{100}$/);
  assert.ok(!p.includes('thân bài'));
});

test('TC-51: > 30 trang trả 1 chương → LlmSplitError (kể cả khi sẽ thêm "Giới thiệu"); 30 trang → hợp lệ', () => {
  const one = (page) => JSON.stringify({ chapters: [{ title: 'A', start_page: page }] });
  assert.throws(() => parseChapters(one(1), 31), (e) => e instanceof LlmSplitError && /1 chương cho sách 31 trang/.test(e.message));
  assert.deepStrictEqual(parseChapters(one(1), 30), [{ title: 'A', startPage: 1 }]);
  assert.throws(() => parseChapters(one(5), 338), LlmSplitError);
});

const fakeRes = (status, body) => ({ ok: status < 300, status, text: async () => body, json: async () => JSON.parse(body) });

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
