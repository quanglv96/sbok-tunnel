'use strict';

const { withRetry } = require('./retry');

const ok = (status) => status >= 200 && status < 300;
/** BR-22: backend từ chối task (không tồn tại / sai token / đã kết thúc) → dừng job. */
const REJECTED = new Set([404, 401, 409]);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', 'host.docker.internal']);

/** BR-22: dòng log lúc boot: URL callback; chế độ local (không token Cloudflare) mà host lạ → cảnh báo. */
function backendBootLines({ backendUrl, tunnelToken }) {
  const lines = [`Callback backend: ${backendUrl}`];
  let host = '';
  try {
    host = new URL(backendUrl).hostname;
  } catch {
    host = '';
  }
  if (!tunnelToken && !LOCAL_HOSTS.has(host)) {
    lines.push(`Cảnh báo: chế độ local nhưng SBOK_BACKEND_URL không trỏ localhost/127.0.0.1/host.docker.internal (${host || 'URL sai'})`);
  }
  return lines;
}

/** Số chương trong detail tiến độ ("Chương 2/5 · ..."), null nếu không có. */
const chapterOf = (detail) => {
  const m = /Chương (\d+)\//.exec(detail || '');
  return m ? m[1] : null;
};

/** Gọi ngược sbok-service /internal/worker/* (token X-Worker-Token). */
function createBackendClient({ backendUrl, workerToken }, { fetchImpl = fetch, log = console.log } = {}) {
  const lastProgress = new Map();

  async function post(path, body) {
    const url = `${backendUrl}/internal/worker/${path}`;
    const started = Date.now();
    const { status, text } = await send(url, path, body);
    const task = body.taskId ? ` task ${body.taskId}` : '';
    const line = `Callback ${path}${task} → HTTP ${status} (${Date.now() - started} ms)`;
    if (!ok(status)) {
      log(`${line} ${url} ${String(text || '').slice(0, 200)}`.trimEnd());
    } else if (path !== 'progress' || changed(body)) {
      log(line);
    }
    if (REJECTED.has(status)) {
      throw Object.assign(new Error(`backend HTTP ${status} ở callback ${path}`), { rejected: true, status });
    }
    return status;
  }

  /** progress 2xx chỉ log khi đổi stage hoặc sang chương mới. */
  function changed({ taskId, stage, detail }) {
    const key = `${stage}|${chapterOf(detail)}`;
    if (lastProgress.get(taskId) === key) return false;
    lastProgress.set(taskId, key);
    return true;
  }

  async function send(url, path, body) {
    return withRetry(async () => {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Worker-Token': workerToken },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      // 4xx là trả lời cuối của backend (vd 507 QUOTA_FULL, 409 task đã kết thúc): không thử lại
      if (res.status >= 500 && res.status !== 507) throw new Error(`backend HTTP ${res.status}`);
      const text = ok(res.status) || typeof res.text !== 'function' ? '' : await res.text().catch(() => '');
      return { status: res.status, text };
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

module.exports = { createBackendClient, backendBootLines };
