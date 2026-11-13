'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { synthesizeBatch } = require('../src/tts/ttsRunner');

/** Tiến trình giả: `script(child)` phát stdout/stderr/close như Python thật. */
function fakeSpawn(script, seen) {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)); };
    seen.child = child;
    seen.args = args;
    setImmediate(() => script(child));
    return child;
  };
}

function items() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-tts-'));
  return [0, 1].map((i) => ({ in: path.join(dir, `${i}.txt`), out: path.join(dir, `${i}.mp3`) }));
}

const config = { pythonPath: 'python', ffmpegPath: 'ffmpeg', mp3Bitrate: '96k' };

test('TC-65: synthesizeBatch ghi file batch, 1 tiến trình, đọc JSON từng chương (dòng bị cắt, dòng rác)', async () => {
  const seen = {};
  const done = [];
  const logs = [];
  const list = items();
  await synthesizeBatch(config, list, (l) => logs.push(l), (i, r) => done.push([i, r.durationSec]), fakeSpawn((c) => {
    c.stderr.emit('data', 'chapter 1/2\nchunk 1/1\n');
    c.stdout.emit('data', 'SDK loaded\n{"index": 0, "dur');
    c.stdout.emit('data', 'ationSec": 5}\n{"index": 1, "durationSec": 7}\n');
    c.emit('close', 0);
  }, seen));
  assert.deepStrictEqual(done, [[0, 5], [1, 7]]);
  assert.deepStrictEqual(logs, ['[tts] chapter 1/2', '[tts] chunk 1/1']);
  const batch = seen.args[seen.args.indexOf('--batch') + 1];
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(batch, 'utf8')), list);
});

test('TC-65: synthesizeBatch thoát mã ≠ 0 → reject', async () => {
  await assert.rejects(synthesizeBatch(config, items(), () => {}, () => {}, fakeSpawn((c) => c.emit('close', 1), {})),
    /TTS thoát mã 1/);
});

test('TC-65: onChapterDone ném lỗi → kill tiến trình, reject đúng lỗi đó', async () => {
  const seen = {};
  const p = synthesizeBatch(config, items(), () => {}, () => { throw new Error('mp3 thiếu'); }, fakeSpawn((c) => {
    c.stdout.emit('data', '{"index": 0, "durationSec": 1}\n');
  }, seen));
  await assert.rejects(p, /mp3 thiếu/);
  assert.ok(seen.child.killed);
});
