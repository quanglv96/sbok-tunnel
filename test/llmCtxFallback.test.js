'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { LlmSplitError, splitWithLlm } = require('../src/extract/llmSplitter');
const { NUM_CTX, chat } = require('../src/ollama');

// Hồi quy job e83b222e: sách 338 trang, Ollama trả HTTP 500 "llama runner process has terminated: exit status 2"
const CRASH = 'Chat: Ollama HTTP 500 {"error":"llama runner process has terminated: exit status 2"}';
const PAGES = Array.from({ length: 338 }, (_, i) => (i % 20 === 0 ? `CHƯƠNG ${i / 20 + 1}\nthân bài` : 'thân bài'));
const OK = JSON.stringify({ chapters: [{ title: 'CHƯƠNG 1', start_page: 1 }, { title: 'CHƯƠNG 2', start_page: 21 }] });

const fakeChat = (failCount, message = CRASH) => {
  const calls = [];
  const fn = async (model, messages, opts) => {
    calls.push({ numCtx: opts.numCtx, promptChars: messages[1].content.length, timeoutMs: opts.timeoutMs });
    if (calls.length <= failCount) throw new Error(message);
    return { content: OK, stats: { totalMs: 1 } };
  };
  return { fn, calls };
};

test('TC-69a: runner chết ở num_ctx lớn → thử ngay num_ctx nhỏ hơn trong cùng lượt và thành công', async () => {
  const { fn, calls } = fakeChat(1);
  const r = await splitWithLlm(PAGES, { model: 'qwen2.5:3b', chatFn: fn, timeoutMs: 5000 });
  assert.deepStrictEqual(calls.map((c) => c.numCtx), [NUM_CTX, 8192]);
  assert.ok(calls.every((c) => c.timeoutMs === 5000));
  assert.ok(calls[1].promptChars <= Math.floor(30_000 * 8192 / NUM_CTX));
  assert.strictEqual(r.stats.numCtx, 8192);
  assert.strictEqual(r.stats.ctxTried, `${NUM_CTX}/8192`);
  assert.strictEqual(r.chapters.length, 2);
});

test('TC-69b: chạy tốt ngay lần đầu → chỉ 1 lần gọi với NUM_CTX', async () => {
  const { fn, calls } = fakeChat(0);
  const r = await splitWithLlm(PAGES, { model: 'qwen2.5:3b', chatFn: fn });
  assert.deepStrictEqual(calls.map((c) => c.numCtx), [NUM_CTX]);
  assert.ok(calls[0].promptChars <= 30_000);
  assert.strictEqual(r.stats.numCtx, NUM_CTX);
  assert.strictEqual(r.stats.ctxTried, undefined);
});

test('TC-69c: runner chết ở mọi mức ngữ cảnh → LlmSplitError ghi các mức đã thử (đi luồng thử lại)', async () => {
  const { fn, calls } = fakeChat(99);
  await assert.rejects(splitWithLlm(PAGES, { model: 'qwen2.5:3b', chatFn: fn }),
    (err) => err instanceof LlmSplitError && /exit status 2/.test(err.message) && err.message.includes(`${NUM_CTX}/8192/4096`));
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(calls.map((c) => c.numCtx), [NUM_CTX, 8192, 4096]);
  assert.ok(calls[2].promptChars <= 7500);
});

for (const msg of ['connect ECONNREFUSED 127.0.0.1:11434', 'Ollama timeout sau 600000 ms',
  'Ollama HTTP 500 {"error":"model not found"}']) {
  test(`TC-69d: lỗi khác (${msg}) → không lùi ngữ cảnh, ném luôn, không ghi "[đã thử"`, async () => {
    const { fn, calls } = fakeChat(99, msg);
    await assert.rejects(splitWithLlm(PAGES, { model: 'qwen2.5:3b', chatFn: fn }),
      (err) => err instanceof LlmSplitError && !err.message.includes('[đã thử'));
    assert.strictEqual(calls.length, 1);
  });
}

for (const msg of ['Ollama HTTP 500 {"error":"Out Of Memory"}', 'Ollama HTTP 500 {"error":"UNABLE TO ALLOCATE CUDA buffer"}',
  'Ollama HTTP 500 {"error":"Failed To Allocate KV cache"}', 'Ollama HTTP 500 {"error":"Bad Allocation"}',
  'Ollama HTTP 500 {"error":"LLAMA RUNNER PROCESS HAS TERMINATED: exit status 2"}']) {
  test(`TC-69d: mẫu thiếu bộ nhớ (${msg}) không phân biệt hoa thường → có lùi ngữ cảnh`, async () => {
    const { fn, calls } = fakeChat(1, msg);
    const r = await splitWithLlm(PAGES, { model: 'qwen2.5:3b', chatFn: fn });
    assert.ok(calls.length >= 2);
    assert.strictEqual(r.stats.numCtx, 8192);
  });
}

test('TC-69e: chat gửi options.num_ctx theo tham số numCtx', async () => {
  let body = '';
  const requestFn = (url, opts, onRes) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = (b) => {
      body = b;
      const res = new EventEmitter();
      Object.assign(res, { statusCode: 200, complete: true, setEncoding: () => {} });
      onRes(res);
      res.emit('data', '{"message":{"content":"{}"},"done":true}\n');
      res.emit('end');
    };
    return req;
  };
  await chat('m', [], { requestFn, numCtx: 4096 });
  assert.strictEqual(JSON.parse(body).options.num_ctx, 4096);
  await chat('m', [], { requestFn });
  assert.strictEqual(JSON.parse(body).options.num_ctx, NUM_CTX);
});
