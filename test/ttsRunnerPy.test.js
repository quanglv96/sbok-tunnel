'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

// Unit test Python của tts_runner.py (stdlib unittest, không cần vieneu/onnxruntime). Máy không có python thì bỏ qua.
const python = 'python';
const probe = spawnSync(python, ['-I', '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
const hasPython = probe.status === 0 && probe.stdout.trim() === '3';

test('tts_runner.disable_codec_arena: tắt arena codec decoder, lỗi thì giữ session cũ', { skip: !hasPython && 'không có python 3' }, () => {
  const r = spawnSync(python, ['-I', path.join(__dirname, '..', 'python', 'test_tts_runner.py')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
});
