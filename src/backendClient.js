'use strict';

const { withRetry } = require('./retry');

const ok = (status) => status >= 200 && status < 300;

/** Gọi ngược sbok-service /internal/worker/* (token X-Worker-Token). */
function createBackendClient({ backendUrl, workerToken }, { fetchImpl = fetch, log = console.log } = {}) {
  async function post(path, body) {
    const status = await send(path, body);
    // log từng bước gọi backend; progress 2xx gửi liên tục nên không log
    if (!ok(status) || path !== 'progress') {
      log(`Callback ${path}${body.taskId ? ` task ${body.taskId}` : ''}: HTTP ${status}`);
    }
    return status;
  }

  async function send(path, body) {
    return withRetry(async () => {
      const res = await fetchImpl(`${backendUrl}/internal/worker/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Worker-Token': workerToken },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      // 4xx là trả lời cuối của backend (vd 507 QUOTA_FULL, 409 task đã kết thúc): không thử lại
      if (res.status >= 500 && res.status !== 507) throw new Error(`backend HTTP ${res.status}`);
      return res.status;
    }, { attempts: 3, backoffMs: 2000, onError: (e, n) => log(`Callback ${path} lỗi lần ${n}: ${e.message}`) });
  }

  return {
    progress: (taskId, stage, detail) => post('progress', { taskId, stage, detail }),
    /** BR-18: một chương xong (MP3 ở máy này); true nếu backend đã ghi nhận (2xx). */
    chapterDone: async (taskId, bookTitle, author, chapter) =>
      ok(await post('chapter-done', { taskId, bookTitle, author, chapter })),
    /** Mọi chương đã báo qua chapter-done. */
    complete: (taskId) => post('complete', { taskId }),
    /** BR-19: đẩy chương lên R2 xong / lỗi (`missing`: không còn MP3). */
    chapterUploaded: (taskId, index, r2Key, sizeBytes) => post('chapter-uploaded', { taskId, index, r2Key, sizeBytes }),
    chapterUploadFailed: (taskId, index, missing) => post('chapter-upload-failed', { taskId, index, missing }),
    violation: (taskId, violation) => post('violation', { taskId, violation }),
    failed: (taskId, message) => post('failed', { taskId, message }),
    /** true nếu còn chỗ cho {@code bytes} trên R2 (BR-6). */
    quotaOk: async (bytes) => (await post('quota-check', { bytes })) === 204,
  };
}

module.exports = { createBackendClient };
