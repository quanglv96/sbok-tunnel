'use strict';

const { spawn } = require('child_process');
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

module.exports = { synthesize };
