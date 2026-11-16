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
 * HTTP local (expose qua Cloudflare Tunnel): GET /health cho heartbeat, POST /jobs nhận PDF (raw body),
 * POST /chapters/upload?taskId=&index= yêu cầu đẩy MP3 chương lên R2 (BR-19, chạy ngoài hàng đợi TTS). Mọi request
 * cần X-Worker-Token. Job (kể cả lượt đọc tiếp – `enqueue`) chạy tuần tự (1 GPU/CPU cho TTS).
 * `onQueued(job, position)`: sau 202 báo backend QUEUED (916-dev); lỗi bỏ qua, job vẫn vào hàng đợi.
 */
function createJobServer(config, { isReady, runJob, onQueued = () => {}, onUpload = () => {}, log = console.log }) {
  const queue = [];
  let busy = false;

  function enqueue(job) {
    queue.push(job);
    drain();
  }

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
    if (req.method === 'POST' && url.pathname === '/chapters/upload') {
      const id = url.searchParams.get('taskId') || '';
      const index = url.searchParams.get('index') || '';
      if (!TASK_ID.test(id) || !/^\d{1,6}$/.test(index)) {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(202).end();
      Promise.resolve().then(() => onUpload(id, Number(index)))
        .catch((err) => log(`Đẩy chương ${id}/${index} lỗi: ${err.message}`));
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
      const job = { taskId, pdfPath, fileName: (url.searchParams.get('fileName') || 'book.pdf').slice(0, 255) };
      const position = queue.length + 1;
      res.writeHead(202).end();
      log(`Nhận job ${taskId} (${size} B), hàng đợi ${position}`);
      // báo QUEUED xong mới cho chạy, để sự kiện không đến sau VERIFYING
      Promise.resolve().then(() => onQueued(job, position)).catch(() => {}).then(() => enqueue(job));
    });
  });

  return {
    listen: () => new Promise((resolve) => server.listen(config.port, '127.0.0.1', resolve)),
    close: () => {
      server.close();
      server.closeAllConnections();
    },
    enqueue,
    /** #208: có job đang chạy hoặc đang chờ (chặn "Nghe thử"). */
    isBusy: () => busy || queue.length > 0,
  };
}

module.exports = { createJobServer, tokenOk };
