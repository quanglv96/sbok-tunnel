'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJobServer } = require('../src/jobServer');

const TOKEN = 'test-token';
const TASK = '0123456789abcdef0123456789abcdef0123';

async function withServer(handlers, fn) {
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-js-'));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const server = createJobServer({ port, workerToken: TOKEN, jobsDir }, { isReady: () => true, log: () => {}, ...handlers });
  await server.listen();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    fs.rmSync(jobsDir, { recursive: true, force: true });
  }
}

const post = (url, token = TOKEN, body = undefined) => fetch(url, {
  method: 'POST', headers: token ? { 'X-Worker-Token': token } : {}, body,
});
const tick = () => new Promise((r) => setTimeout(r, 50));

test('TC-81: nhận PDF → 202, báo QUEUED (kèm vị trí) trước khi chạy job; lỗi báo QUEUED job vẫn chạy', async () => {
  const events = [];
  await withServer({
    onQueued: async (job, pos) => {
      events.push(`queued ${pos}`);
      throw new Error('backend down');
    },
    runJob: async (job) => { events.push(`run ${job.taskId}`); },
  }, async (base) => {
    const res = await post(`${base}/jobs?taskId=${TASK}&fileName=a.pdf`, TOKEN, '%PDF-1.7');
    assert.strictEqual(res.status, 202);
    await tick();
  });
  assert.deepStrictEqual(events, ['queued 1', `run ${TASK}`]);
});

test('TC-94: POST /chapters/upload: token sai → 401; taskId/index sai → 400; hợp lệ → 202 rồi gọi đẩy', async () => {
  const uploads = [];
  await withServer({ runJob: async () => {}, onUpload: async (id, index) => uploads.push([id, index]) }, async (base) => {
    assert.strictEqual((await post(`${base}/chapters/upload?taskId=${TASK}&index=1`, null)).status, 401);
    assert.strictEqual((await post(`${base}/chapters/upload?taskId=${TASK}&index=1`, 'sai')).status, 401);
    assert.strictEqual((await post(`${base}/chapters/upload?taskId=../x&index=1`)).status, 400);
    assert.strictEqual((await post(`${base}/chapters/upload?taskId=${TASK}&index=-1`)).status, 400);
    assert.strictEqual((await post(`${base}/chapters/upload?taskId=${TASK}&index=1.5`)).status, 400);
    assert.strictEqual((await post(`${base}/chapters/upload?taskId=${TASK}&index=0`)).status, 202);
    assert.strictEqual((await post(`${base}/chapters/upload?taskId=${TASK}&index=3`)).status, 202);
    await tick();
  });
  assert.deepStrictEqual(uploads, [[TASK, 0], [TASK, 3]]);
});
