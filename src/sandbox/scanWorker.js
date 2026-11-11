'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs');

const SCAN_TIMEOUT_MS = 60_000;

/** FR-WK-02: quét PDF trong worker_thread riêng (giới hạn RAM + timeout), không bao giờ thực thi nội dung PDF. */
function runScan(pdfPath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { pdfPath },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Quét PDF quá thời gian'));
    }, SCAN_TIMEOUT_MS);
    worker.once('message', (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.violation);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

if (!isMainThread && workerData && workerData.pdfPath) {
  try {
    const { scanPdf } = require('./scanner');
    parentPort.postMessage({ violation: scanPdf(fs.readFileSync(workerData.pdfPath)) });
  } catch (err) {
    parentPort.postMessage({ error: String(err && err.message ? err.message : err) });
  }
}

module.exports = { runScan };
