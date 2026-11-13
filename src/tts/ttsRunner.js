'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', '..', 'python', 'tts_runner.py');

/** FR-WK-04: gọi python/tts_runner.py (VieNeu-TTS v3 Turbo -> MP3). Trả { durationSec }. */
function synthesize({ pythonPath, ffmpegPath, mp3Bitrate }, textPath, mp3Path, log = console.log) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [SCRIPT, '--in', textPath, '--out', mp3Path, '--bitrate', mp3Bitrate,
      '--ffmpeg', ffmpegPath], { windowsHide: true, env: { ...process.env, HF_HUB_OFFLINE: '1' } });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => log(`[tts] ${String(d).trim()}`));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`TTS thoát mã ${code}`));
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
 * P1 (AC-23): một tiến trình Python, nạp model 1 lần cho cả job. `items` = [{ in, out }]; mỗi chương xong gọi
 * `onChapterDone(i, { durationSec })` (i từ 0). Thoát mã ≠ 0 → reject; `onChapterDone` ném lỗi → kill tiến trình, reject.
 */
function synthesizeBatch({ pythonPath, ffmpegPath, mp3Bitrate }, items, log = console.log, onChapterDone = () => {},
  spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const batchFile = path.join(path.dirname(items[0].in), 'tts-batch.json');
    fs.writeFileSync(batchFile, JSON.stringify(items), 'utf8');
    const child = spawnFn(pythonPath, [SCRIPT, '--batch', batchFile, '--bitrate', mp3Bitrate, '--ffmpeg', ffmpegPath],
      { windowsHide: true, env: { ...process.env, HF_HUB_OFFLINE: '1' } });
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

module.exports = { synthesize, synthesizeBatch };
