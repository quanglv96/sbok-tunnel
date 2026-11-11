'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const TASK_ID = /^[0-9a-f-]{36}$/;

function tokenOk(expected, actual) {
  if (!expected || typeof actual !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * HTTP local (expose qua Cloudflare Tunnel): GET /health cho heartbeat, POST /jobs nhận PDF (raw body). Mọi request
 * cần X-Worker-Token. Job chạy tuần tự (1 GPU/CPU cho TTS).
 */
function createJobServer(config, { isReady, runJob, log = console.log }) {
  const queue = [];
  let busy = false;

  async function drain() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const job = queue.shift();
      await runJob(job).catch((err) => log(`Job ${job.taskId} lỗi: ${err.message}`));
    }
    busy = false;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!tokenOk(config.workerToken, req.headers['x-worker-token'])) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(isReady() ? 200 : 503).end();
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/jobs') {
      res.writeHead(404).end();
      return;
    }
    const taskId = url.searchParams.get('taskId') || '';
    if (!TASK_ID.test(taskId) || !isReady()) {
      res.writeHead(isReady() ? 400 : 503).end();
      return;
    }
    fs.mkdirSync(config.jobsDir, { recursive: true });
    const pdfPath = path.join(config.jobsDir, `${taskId}.pdf`);
    const out = fs.createWriteStream(pdfPath);
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_PDF_BYTES) {
        req.destroy();
        out.destroy();
        fs.rmSync(pdfPath, { force: true });
      }
    });
    req.pipe(out);
    out.on('finish', () => {
      if (size === 0 || size > MAX_PDF_BYTES) {
        fs.rmSync(pdfPath, { force: true });
        res.writeHead(400).end();
        return;
      }
      queue.push({ taskId, pdfPath, fileName: (url.searchParams.get('fileName') || 'book.pdf').slice(0, 255) });
      res.writeHead(202).end();
      log(`Nhận job ${taskId} (${size} B), hàng đợi ${queue.length}`);
      drain();
    });
  });

  return {
    listen: () => new Promise((resolve) => server.listen(config.port, '127.0.0.1', resolve)),
    close: () => server.close(),
  };
}

module.exports = { createJobServer, tokenOk };
