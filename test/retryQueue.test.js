'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRetryQueue, nextRetry, saveJob } = require('../src/retryQueue');

test('TC-86: lịch đọc tiếp 1 / 5 / 15 phút, tối đa 3 lần', () => {
  const now = Date.parse('2026-11-16T00:00:00Z');
  assert.deepStrictEqual(nextRetry(0, now), { attempt: 1, minutes: 1, nextRetryAt: '2026-11-16T00:01:00.000Z' });
  assert.strictEqual(nextRetry(1, now).minutes, 5);
  assert.strictEqual(nextRetry(2, now).minutes, 15);
  assert.strictEqual(nextRetry(3, now), null);
});

test('TC-88: khởi động lại nạp job.json, chạy đúng giờ hẹn; job.json hỏng bị bỏ qua, không crash', () => {
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-retry-'));
  const now = Date.parse('2026-11-16T00:00:00Z');
  saveJob(jobsDir, { taskId: 'a', chapters: [], nextRetryAt: '2026-11-16T00:05:00.000Z' });
  saveJob(jobsDir, { taskId: 'b', chapters: [], nextRetryAt: null }); // app tắt giữa lúc đọc → chạy ngay
  fs.mkdirSync(path.join(jobsDir, 'c'));
  fs.writeFileSync(path.join(jobsDir, 'c', 'job.json'), '{hỏng');
  fs.mkdirSync(path.join(jobsDir, 'd')); // thư mục không có job.json

  const timers = [];
  const enqueued = [];
  const logs = [];
  const q = createRetryQueue({
    jobsDir, enqueue: (j) => enqueued.push(j), log: (l) => logs.push(l), now: () => now,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });

  assert.strictEqual(q.load(), 2);
  assert.deepStrictEqual(timers.map((t) => t.ms).sort((x, y) => x - y), [0, 300_000]);
  assert.ok(logs.some((l) => l.includes('c') && l.includes('hỏng')));
  timers.forEach((t) => t.fn());
  assert.deepStrictEqual(enqueued.map((j) => j.taskId).sort(), ['a', 'b']);
  assert.ok(enqueued.every((j) => j.resume === true));
  fs.rmSync(jobsDir, { recursive: true, force: true });
});
