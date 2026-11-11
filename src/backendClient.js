'use strict';

const { withRetry } = require('./retry');

/** Gọi ngược sbok-service /internal/worker/* (token X-Worker-Token). */
function createBackendClient({ backendUrl, workerToken }, { fetchImpl = fetch, log = console.log } = {}) {
  async function post(path, body) {
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
    progress: (taskId, stage) => post('progress', { taskId, stage }),
    complete: (taskId, title, author, chapters) => post('complete', { taskId, title, author, chapters }),
    violation: (taskId, violation) => post('violation', { taskId, violation }),
    failed: (taskId, message) => post('failed', { taskId, message }),
    /** true nếu còn chỗ cho {@code bytes} trên R2 (BR-6). */
    quotaOk: async (bytes) => (await post('quota-check', { bytes })) === 204,
  };
}

module.exports = { createBackendClient };
