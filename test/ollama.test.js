'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { OLLAMA_URL, chat, pull } = require('../src/ollama');
const { LlmSplitError, splitWithLlm } = require('../src/extract/llmSplitter');

/** FEAT-007 B1: chat qua http.request, stub Ollama giữ header như khi prefill prompt dài (TC-30…TC-34). */

const DONE = { done: true, prompt_eval_count: 812, eval_count: 37, prompt_eval_duration: 1_500_000_000, eval_duration: 9e8 };
const NDJSON = [{ message: { content: '{"chapters":[{"title":"C1",' } }, { message: { content: '"start_page":1}]}' } },
  { message: { content: '' }, ...DONE }].map((l) => JSON.stringify(l)).join('\n');

/** Stub: `handler(req, res)` sau khi đọc hết body; trả { url, close, sockets }. */
async function stub(handler) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, res, body));
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, sockets,
    close: () => { sockets.forEach((s) => s.destroy()); return new Promise((r) => server.close(r)); },
  };
}

/** requestFn trỏ OLLAMA_URL sang stub. */
const via = (url) => (u, opts, cb) => http.request(u.replace(OLLAMA_URL, url), opts, cb);
const delayed = (ms, fn) => (req, res, body) => setTimeout(() => fn(req, res, body), ms);

test('TC-30: header tới sau 2 s, timeout 5 s → nội dung ghép đúng, không đi qua fetch', async (t) => {
  let sent;
  const s = await stub(delayed(2000, (req, res, body) => {
    sent = { url: req.url, body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(NDJSON);
  }));
  t.after(s.close);
  const realFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = (...a) => { fetchCalls++; return realFetch(...a); };
  try {
    const r = await chat('qwen2.5:3b', [{ role: 'user', content: 'x' }], { requestFn: via(s.url), timeoutMs: 5000 });
    assert.strictEqual(r.content, '{"chapters":[{"title":"C1","start_page":1}]}');
    assert.ok(r.stats.firstByteMs >= 1900, `firstByteMs ${r.stats.firstByteMs}`);
    assert.strictEqual(sent.url, '/api/chat');
    assert.strictEqual(sent.body.format, 'json');
    assert.strictEqual(sent.body.stream, true);
    assert.strictEqual(fetchCalls, 0);
  } finally {
    global.fetch = realFetch;
  }
});

test('TC-31: header tới sau 2 s, timeout 500 ms → lỗi "timeout", LlmSplitError, socket bị đóng', async (t) => {
  const s = await stub(delayed(2000, (req, res) => { if (!res.destroyed) res.end(NDJSON); }));
  t.after(s.close);
  const started = Date.now();
  await assert.rejects(chat('m', [], { requestFn: via(s.url), timeoutMs: 500 }), /timeout/);
  assert.ok(Date.now() - started < 1500);
  await assert.rejects(
    splitWithLlm(['a'], { model: 'm', chatFn: (m, msgs) => chat(m, msgs, { requestFn: via(s.url), timeoutMs: 500 }) }),
    (err) => err instanceof LlmSplitError && /timeout/.test(err.message));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(s.sockets.size, 0, 'socket stub đã đóng');
});

test('TC-32: Ollama không chạy (cổng đóng) → lỗi có mã ECONNREFUSED', async () => {
  const s = await stub(() => {});
  await s.close();
  await assert.rejects(chat('m', [], { requestFn: via(s.url), timeoutMs: 5000 }), (err) => err.code === 'ECONNREFUSED');
  await assert.rejects(
    splitWithLlm(['a'], { model: 'm', chatFn: (m, msgs) => chat(m, msgs, { requestFn: via(s.url) }) }),
    (err) => err instanceof LlmSplitError && err.message.includes('ECONNREFUSED') && !/fetch failed/.test(err.message));
});

test('TC-33: HTTP 500 / dòng error / đóng kết nối giữa stream → lỗi (LlmSplitError khi qua splitter)', async (t) => {
  const cases = [
    [(req, res) => { res.writeHead(500); res.end('boom'); }, /HTTP 500 boom/],
    [(req, res) => { res.writeHead(200); res.end('{"error":"model requires more system memory"}'); }, /more system memory/],
    [(req, res) => { res.writeHead(200); res.write(`${JSON.stringify({ message: { content: '{' } })}\n`);
      setTimeout(() => res.socket.destroy(), 50); }, /đóng kết nối/],
    [(req, res) => { res.writeHead(200); res.end(`${JSON.stringify({ message: { content: '{' } })}\n`); }, /trước khi trả xong/],
  ];
  for (const [handler, re] of cases) {
    const s = await stub(handler);
    t.after(s.close);
    await assert.rejects(chat('m', [], { requestFn: via(s.url), timeoutMs: 5000 }), re);
    await assert.rejects(
      splitWithLlm(['a'], { model: 'm', chatFn: (m, msgs) => chat(m, msgs, { requestFn: via(s.url), timeoutMs: 5000 }) }),
      (err) => err instanceof LlmSplitError && re.test(err.message));
  }
});

test('TC-34: dòng done:true có số liệu → chat trả stats', async (t) => {
  const s = await stub((req, res) => { res.writeHead(200); res.end(NDJSON); });
  t.after(s.close);
  const { stats } = await chat('m', [], { requestFn: via(s.url), timeoutMs: 5000 });
  assert.strictEqual(stats.prompt_eval_count, 812);
  assert.strictEqual(stats.eval_count, 37);
  assert.strictEqual(stats.prompt_eval_duration, 1_500_000_000);
  assert.strictEqual(stats.eval_duration, 9e8);
  assert.ok(stats.totalMs >= stats.firstByteMs);
});

test('pull đọc stream từng dòng, gọi onProgress; dòng error → ném', async () => {
  const lines = ['{"status":"pulling","total":100,"completed":10}', '{"status":"pulling","total":100,"completed":100}',
    '{"status":"success"}'];
  const body = new ReadableStream({
    start(c) { lines.forEach((l) => c.enqueue(new TextEncoder().encode(`${l}\n`))); c.close(); },
  });
  const seen = [];
  await pull('m', { fetchFn: async () => ({ ok: true, status: 200, body }), onProgress: (a, b) => seen.push([a, b]) });
  assert.deepStrictEqual(seen, [[10, 100], [100, 100]]);
  await assert.rejects(pull('m', { fetchFn: async () => ({ ok: true, status: 200, text: async () => '{"error":"no space"}' }) }),
    /no space/);
  await assert.rejects(pull('m', { fetchFn: async () => ({ ok: false, status: 500, text: async () => 'x' }) }), /HTTP 500/);
});
