'use strict';

const cut = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * FEAT-007 (BR-9…BR-11): báo admin-service khi tách chương LLM lỗi hẳn. Thiếu cấu hình, HTTP lỗi, timeout → chỉ log,
 * không ném, không thử lại (BR-10). Payload không chứa nội dung sách. Trả true nếu admin-service nhận.
 */
async function notifyChapterSplitFailed(config, payload, { log = console.log, fetchFn = fetch, timeoutMs = 10_000 } = {}) {
  const { taskId } = payload;
  if (!config.adminAlertUrl || !config.adminApiKey) {
    log(`Task ${taskId}: chưa cấu hình SBOK_ADMIN_ALERT_URL/SBOK_ADMIN_API_KEY, bỏ qua báo admin`);
    return false;
  }
  const body = {
    taskId: cut(taskId, 100),
    bookTitle: cut(payload.bookTitle, 500),
    model: cut(payload.model, 100),
    attempts: payload.attempts,
    error: cut(payload.error, 2000),
    host: cut(payload.host, 200),
    occurredAt: payload.occurredAt,
  };
  try {
    const res = await fetchFn(`${config.adminAlertUrl}/api/alerts/chapter-split`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': config.adminApiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log(`Task ${taskId}: báo admin lỗi HTTP ${res.status}`);
      return false;
    }
    log(`Task ${taskId}: đã báo admin tách chương LLM lỗi`);
    return true;
  } catch (err) {
    log(`Task ${taskId}: báo admin lỗi (${err.message})`);
    return false;
  }
}

module.exports = { notifyChapterSplitFailed };
