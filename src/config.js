'use strict';

const os = require('os');
const path = require('path');

/** Cấu hình từ env (BR-14: bí mật không hard-code). */
function loadConfig(env = process.env) {
  const workDir = env.SBOK_WORK_DIR || path.join(os.homedir(), '.sbok-tunnel');
  return {
    port: Number(env.SBOK_WORKER_PORT || 7860),
    workerToken: env.SBOK_WORKER_TOKEN || '',
    backendUrl: (env.SBOK_BACKEND_URL || 'https://sbok.xvibe.me/api/sbok').replace(/\/+$/, ''),
    tunnelToken: env.CLOUDFLARE_TUNNEL_TOKEN || '',
    cloudflaredPath: env.CLOUDFLARED_PATH || 'cloudflared',
    metricsPort: Number(env.CLOUDFLARED_METRICS_PORT || 20241),
    pythonPath: env.PYTHON_PATH || 'python',
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
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

module.exports = { loadConfig };
