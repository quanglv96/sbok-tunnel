'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { ensureRunning, serve } = require('../src/ollama');

/** Hồi quy job 9db42cbb: Ollama do tunnel serve bị sập → lượt sau phải chạy lại serve (TC-68). Chạy tuần tự. */

const fakeChild = () => Object.assign(new EventEmitter(), { unref: () => {} });
const DOWN = async () => ({ running: false, hasModel: false });
const UP = async () => ({ running: true, hasModel: true });

test('TC-68a: chưa từng serve (Ollama người dùng tự chạy) → không tự khởi động', async () => {
  let started = 0;
  const r = await ensureRunning('m', { check: DOWN, start: () => { started++; } });
  assert.strictEqual(started, 0);
  assert.deepStrictEqual(r, { running: false, hasModel: false, restarted: false });
});

test('TC-68b: serve báo thoát qua onExit; server chết → chạy lại serve cùng tham số, chờ lên', async () => {
  const exits = [];
  const child = fakeChild();
  const env = { OLLAMA_HOST: '127.0.0.1:11434' };
  serve('C:/rt/ollama/ollama.exe', env, { onExit: (c, s) => exits.push([c, s]), spawnFn: () => child });
  child.emit('exit', 3221225477, null);
  assert.deepStrictEqual(exits, [[3221225477, null]]);

  const starts = [];
  const r = await ensureRunning('m', {
    check: DOWN,
    start: (exe, e, opts) => starts.push({ exe, e, hasOnExit: typeof opts.onExit === 'function' }),
    wait: async () => ({ running: true, hasModel: true }),
  });
  assert.deepStrictEqual(starts, [{ exe: 'C:/rt/ollama/ollama.exe', e: env, hasOnExit: true }]);
  assert.deepStrictEqual(r, { running: true, hasModel: true, restarted: true });
});

test('TC-68c: server đang chạy → không serve lại', async () => {
  let started = 0;
  const r = await ensureRunning('m', { check: UP, start: () => { started++; } });
  assert.strictEqual(started, 0);
  assert.strictEqual(r.restarted, false);
});

test('TC-68d: serve lại nhưng không lên → running false, không ném lỗi', async () => {
  const r = await ensureRunning('m', { check: DOWN, start: () => {}, wait: async () => ({ running: false, hasModel: false }) });
  assert.deepStrictEqual(r, { running: false, hasModel: false, restarted: true });
});
