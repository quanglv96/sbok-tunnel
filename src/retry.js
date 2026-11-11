'use strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Thử lại {@code attempts} lần, chờ backoffMs × 2^(lần-1) giữa các lần (BR-10). */
async function withRetry(fn, { attempts = 3, backoffMs = 1000, onError = () => {}, wait = sleep } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      onError(err, attempt);
      if (attempt < attempts) await wait(backoffMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

module.exports = { withRetry, sleep };
