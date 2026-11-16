'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ttsEnv } = require('../ttsSettings');

const SCRIPT = path.join(__dirname, '..', '..', 'python', 'tts_runner.py');

/** #208: `tts` (cấu hình đọc đã resolve) thắng env của app; không có thì giữ env + `mp3Bitrate` như cũ. */
function childArgs({ mp3Bitrate, tts }) {
  return {
    bitrate: tts ? tts.bitrate : mp3Bitrate,
    env: { ...process.env, HF_HUB_OFFLINE: '1', ...(tts ? ttsEnv(tts) : {}) },
  };
}

/** FR-WK-04: gọi python/tts_runner.py (VieNeu-TTS -> MP3) cho một file. Trả { durationSec }. */
function synthesize({ pythonPath, ffmpegPath, mp3Bitrate, tts }, textPath, mp3Path, log = console.log, spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const { bitrate, env } = childArgs({ mp3Bitrate, tts });
    const child = spawnFn(pythonPath, [SCRIPT, '--in', textPath, '--out', mp3Path, '--bitrate', bitrate,
      '--ffmpeg', ffmpegPath], { windowsHide: true, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => {
      stderr += d;
      log(`[tts] ${String(d).trim()}`);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim().split('\n').pop() || `TTS thoát mã ${code}`));
      const last = stdout.trim().split('\n').pop() || '{}';
      try {
        resolve(JSON.parse(last));
      } catch {
        resolve({ durationSec: null });
      }
    });
  });
}

/**
 * #208 "Nghe thử": đọc `text` bằng cấu hình `tts` đang chọn (chưa cần lưu) ra file preview riêng
 * `{dir}/preview.mp3`. Trả đường dẫn MP3. Chặn khi có job/chưa ready là việc của nơi gọi (main.js).
 */
async function preview(config, tts, text, dir, log = console.log, spawnFn = spawn) {
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'preview.txt');
  const out = path.join(dir, 'preview.mp3');
  fs.writeFileSync(src, text, 'utf8');
  await synthesize({ ...config, tts }, src, out, log, spawnFn);
  return out;
}

/**
 * P1 (AC-23): một tiến trình Python, nạp model 1 lần cho cả job. `items` = [{ in, out }]; mỗi chương xong gọi
 * `onChapterDone(i, { durationSec })` (i từ 0). Thoát mã ≠ 0 → reject; `onChapterDone` ném lỗi → kill tiến trình, reject.
 */
function synthesizeBatch({ pythonPath, ffmpegPath, mp3Bitrate, tts }, items, log = console.log, onChapterDone = () => {},
  spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const batchFile = path.join(path.dirname(items[0].in), 'tts-batch.json');
    fs.writeFileSync(batchFile, JSON.stringify(items), 'utf8');
    const { bitrate, env } = childArgs({ mp3Bitrate, tts });
    const child = spawnFn(pythonPath, [SCRIPT, '--batch', batchFile, '--bitrate', bitrate, '--ffmpeg', ffmpegPath],
      { windowsHide: true, env });
    let buf = '';
    let failure = null;
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // dòng SDK tự in ra stdout
        }
        if (!msg || !Number.isInteger(msg.index) || failure) continue;
        try {
          onChapterDone(msg.index, { durationSec: msg.durationSec ?? null });
        } catch (err) {
          failure = err;
          child.kill();
        }
      }
    });
    child.stderr.on('data', (d) => {
      for (const line of String(d).split('\n')) if (line.trim()) log(`[tts] ${line.trim()}`);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`TTS thoát mã ${code}`));
      resolve();
    });
  });
}

/**
 * #208: tải model `model` vào HF cache (thử offline trước, thiếu mới tải từ huggingface.co như #129) và ghi danh sách
 * giọng. `env`: env runtime (runtimeEnv). Trả Promise<void>, lỗi → reject.
 */
function prefetchModel(pythonPath, env, model, log = console.log, spawnFn = spawn) {
  const run = (offline) => new Promise((resolve) => {
    const child = spawnFn(pythonPath, [SCRIPT, '--prefetch'], {
      windowsHide: true, env: { ...env, VIENEU_MODEL: model, ...(offline ? { HF_HUB_OFFLINE: '1' } : {}) },
    });
    let err = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, out: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, out: err.trim().split('\n').pop() || `mã ${code}` }));
  });
  return run(true).then((r) => (r.ok ? r : (log(`[tts] Đang tải model ${model || 'v3 Turbo'}`), run(false))))
    .then((r) => {
      if (!r.ok) throw new Error(`tải model lỗi: ${r.out}`);
    });
}

module.exports = { preview, prefetchModel, synthesize, synthesizeBatch };
