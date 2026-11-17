'use strict';

const fs = require('fs');
const path = require('path');

/** BR-18 (mục 9.1): chờ đọc tiếp 1 / 5 / 15 phút, tối đa 3 lần. */
const RETRY_DELAYS_MIN = [1, 5, 15];
const MAX_RETRIES = RETRY_DELAYS_MIN.length;
const JOB_FILE = 'job.json';

/** Lỗi ở giai đoạn TTS (chương lỗi, Python thoát): được đọc tiếp. Lỗi khác (trích chữ, cấu hình, vi phạm) thì không. */
class TtsError extends Error {}

/** Lượt đọc tiếp kế tiếp sau `attempt` lần đã đọc tiếp; null = hết lượt. */
function nextRetry(attempt, now = Date.now()) {
  if (attempt >= MAX_RETRIES) return null;
  const minutes = RETRY_DELAYS_MIN[attempt];
  return { attempt: attempt + 1, minutes, nextRetryAt: new Date(now + minutes * 60_000).toISOString() };
}

const jobFile = (jobsDir, taskId) => path.join(jobsDir, taskId, JOB_FILE);

function saveJob(jobsDir, state) {
  const file = jobFile(jobsDir, state.taskId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state), 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

/** null nếu không có hoặc hỏng. */
function readJob(jobsDir, taskId) {
  try {
    const state = JSON.parse(fs.readFileSync(jobFile(jobsDir, taskId), 'utf8'));
    return state && state.taskId === taskId && Array.isArray(state.chapters) ? state : null;
  } catch {
    return null;
  }
}

/**
 * Hẹn giờ đọc tiếp. Tới giờ → `enqueue({ taskId, resume: true })` (cùng hàng đợi của jobServer, một job TTS một lúc).
 * `load()` lúc khởi động: nạp lại mọi `job.json` (đúng giờ hẹn, không hẹn thì chạy ngay); file hỏng → log, bỏ qua.
 */
function createRetryQueue({ jobsDir, enqueue, log = console.log, now = Date.now, setTimer = setTimeout }) {
  const timers = new Map();

  function schedule(state) {
    clearTimeout(timers.get(state.taskId));
    const delay = Math.max(0, Date.parse(state.nextRetryAt) - now());
    timers.set(state.taskId, setTimer(() => {
      timers.delete(state.taskId);
      enqueue({ taskId: state.taskId, resume: true });
    }, delay));
  }

  function load() {
    let names = [];
    try {
      names = fs.readdirSync(jobsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return 0;
    }
    let count = 0;
    for (const taskId of names) {
      if (!fs.existsSync(jobFile(jobsDir, taskId))) continue;
      const state = readJob(jobsDir, taskId);
      if (!state) {
        log(`Đọc tiếp: bỏ qua ${taskId}, job.json hỏng`);
        continue;
      }
      // không có giờ hẹn = app tắt khi job đang đọc: đọc tiếp ngay (job.json chỉ bị xoá khi job kết thúc)
      if (!state.nextRetryAt || Number.isNaN(Date.parse(state.nextRetryAt))) {
        state.nextRetryAt = new Date(now()).toISOString();
      }
      schedule(state);
      count++;
    }
    if (count) log(`Đọc tiếp: nạp lại ${count} job đang hẹn`);
    return count;
  }

  /** BR-22: huỷ hẹn đọc tiếp và xoá `job.json` (giữ MP3 + txt). */
  function cancel(taskId) {
    clearTimeout(timers.get(taskId));
    timers.delete(taskId);
    removeJob(jobsDir, taskId);
  }

  return { schedule, load, cancel };
}

/** Xoá `job.json` của task (txt chương giữ lâu dài, BR-16 v13). */
function removeJob(jobsDir, taskId) {
  fs.rmSync(jobFile(jobsDir, taskId), { force: true });
}

module.exports = { MAX_RETRIES, RETRY_DELAYS_MIN, TtsError, createRetryQueue, nextRetry, readJob, removeJob, saveJob };
