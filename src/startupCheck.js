'use strict';

const { execFile } = require('child_process');
const fs = require('fs');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || stderr || (err && err.message) || '').trim().split('\n')[0] });
    });
  });
}

/** FR-WK-01: cloudflared, đĩa trống, Python + VieNeu-TTS, ffmpeg. Một mục đỏ thì worker không nhận job (TC-33). */
async function startupCheck(config) {
  fs.mkdirSync(config.workDir, { recursive: true });
  const checks = [];
  const cf = await run(config.cloudflaredPath, ['--version']);
  checks.push({ name: 'cloudflared', ok: cf.ok, detail: cf.out });

  const stat = await fs.promises.statfs(config.workDir);
  const freeGb = (stat.bavail * stat.bsize) / 1024 ** 3;
  checks.push({ name: 'Đĩa trống', ok: freeGb >= config.minFreeGb, detail: `${freeGb.toFixed(1)} GB (cần ≥ ${config.minFreeGb} GB)` });

  const py = await run(config.pythonPath, ['--version']);
  checks.push({ name: 'Python', ok: py.ok, detail: py.out });
  const tts = await run(config.pythonPath, ['-c', 'import vieneu_tts, soundfile, numpy; print("ok")']);
  checks.push({ name: 'VieNeu-TTS', ok: tts.ok, detail: tts.ok ? 'đã cài' : tts.out });
  const ff = await run(config.ffmpegPath, ['-version']);
  checks.push({ name: 'ffmpeg', ok: ff.ok, detail: ff.out });

  const missing = ['workerToken', 'tunnelToken'].filter((k) => !config[k]);
  const r2Missing = Object.entries(config.r2).filter(([, v]) => !v).map(([k]) => `R2.${k}`);
  checks.push({ name: 'Cấu hình env', ok: missing.length + r2Missing.length === 0, detail: [...missing, ...r2Missing].join(', ') || 'đủ' });

  return { ok: checks.every((c) => c.ok), checks };
}

module.exports = { startupCheck };
