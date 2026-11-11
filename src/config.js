'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseEnv } = require('util');

/** Nạp `.env` đầu tiên tìm thấy trong `dirs` vào `env`; biến đã đặt cho tiến trình được giữ nguyên. */
function loadEnvFile(dirs, env = process.env) {
  for (const dir of dirs) {
    const file = path.join(dir, '.env');
    if (!fs.existsSync(file)) continue;
    const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined) env[key] = value;
    }
    return file;
  }
  return null;
}

/**
 * Cấu hình từ env (BR-14: bí mật không hard-code). Đường dẫn Python/ffmpeg/thư mục làm việc do app tự quản
 * (BR-15, settings.json), không đọc từ env.
 */
function loadConfig(env = process.env, workDir = path.join(os.homedir(), '.sbok-tunnel')) {
  return {
    port: Number(env.SBOK_WORKER_PORT || 7860),
    workerToken: env.SBOK_WORKER_TOKEN || '',
    backendUrl: (env.SBOK_BACKEND_URL || 'https://sbok.xvibe.me/api/sbok').replace(/\/+$/, ''),
    tunnelToken: env.CLOUDFLARE_TUNNEL_TOKEN || '',
    cloudflaredPath: env.CLOUDFLARED_PATH || 'cloudflared',
    metricsPort: Number(env.CLOUDFLARED_METRICS_PORT || 20241),
    pythonPath: 'python',
    ffmpegPath: 'ffmpeg',
    minFreeGb: Number(env.SBOK_MIN_FREE_GB || 5),
    mp3Bitrate: env.SBOK_MP3_BITRATE || '96k',
    workDir,
    cacheDir: path.join(workDir, 'cache'),
    jobsDir: path.join(workDir, 'jobs'),
    r2: {
      endpoint: env.R2_ENDPOINT || '',
      bucket: env.R2_BUCKET || '',
      accessKeyId: env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: env.R2_SECRET_ACCESS_KEY || '',
    },
  };
}

module.exports = { loadConfig, loadEnvFile };
