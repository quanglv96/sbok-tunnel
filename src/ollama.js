'use strict';

const http = require('http');
const { spawn } = require('child_process');

/** FEAT-007: Ollama chỉ nghe local; hằng số, không đọc từ env/IPC. */
const OLLAMA_HOST = '127.0.0.1:11434';
const OLLAMA_URL = `http://${OLLAMA_HOST}`;
const JSON_HEADERS = { 'content-type': 'application/json' };
// Ngữ cảnh đủ cho phần đầu mọi trang của sách dài với model 3b (KV cache vẫn vừa máy ít RAM)
const NUM_CTX = 16384;
// B1: tổng thời gian chờ một lần gọi chat; prefill prompt dài trên CPU có thể > 5 phút
const CHAT_TIMEOUT_MS = 30 * 60_000;

const parseLine = (l) => {
  try {
    return JSON.parse(l);
  } catch {
    return {};
  }
};

/** Tách body NDJSON thành các object; dòng có `error` → ném lỗi. */
function parseNdjsonLines(text, what) {
  const lines = text.split('\n').filter((l) => l.trim()).map(parseLine);
  const failed = lines.find((l) => l.error);
  if (failed) throw new Error(`${what}: ${String(failed.error).slice(0, 300)}`);
  return lines;
}

/** Đọc body của fetch theo từng dòng (stream) để báo tiến độ; không có body stream thì đọc cả text. */
async function forEachLine(res, onLine) {
  if (!res.body) {
    (await res.text()).split('\n').forEach(onLine);
    return;
  }
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
  onLine(buf + dec.decode());
}

const hasName = (names, model) => names.some((n) => n === model || n === `${model}:latest`);

/** { running, hasModel }; mọi lỗi (chưa chạy, timeout) = running false. */
async function isReady(model, { fetchFn = fetch, timeoutMs = 3000 } = {}) {
  try {
    const res = await fetchFn(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { running: false, hasModel: false };
    const data = await res.json();
    const names = ((data && data.models) || []).map((m) => m.name || m.model);
    return { running: true, hasModel: hasName(names, model) };
  } catch {
    return { running: false, hasModel: false };
  }
}

/** Chờ `ollama serve` lên (tối đa tries × delayMs). */
async function waitReady(model, { tries = 30, delayMs = 1000, check = isReady } = {}) {
  let st = { running: false, hasModel: false };
  for (let i = 0; i < tries; i++) {
    st = await check(model);
    if (st.running) return st;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return st;
}

// Tham số lần `serve` gần nhất, để khởi động lại khi server đã chết (ensureRunning)
let lastServe = null;

/**
 * Chạy `ollama serve` nền (không shell, không cửa sổ). Lỗi spawn chỉ làm waitReady trả running false.
 * `onExit(code, signal)`: báo khi server thoát (crash/bị tắt) để log nguyên nhân.
 */
function serve(exePath, env, { onExit, spawnFn = spawn } = {}) {
  lastServe = { exePath, env, onExit };
  const child = spawnFn(exePath, ['serve'], { env, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  if (onExit) child.on('exit', (code, signal) => onExit(code, signal));
  child.unref();
  return child;
}

/**
 * Trước mỗi lần tách chương: server đã chết (ECONNRESET/ECONNREFUSED) mà tunnel từng chạy `serve` thì chạy lại
 * với tham số cũ và chờ lên. Ollama do người dùng tự chạy (tunnel chưa serve) thì không tự khởi động.
 * Trả { running, hasModel, restarted }; không ném lỗi.
 */
async function ensureRunning(model, { check = isReady, start = serve, wait = waitReady } = {}) {
  const st = await check(model);
  if (st.running || !lastServe) return { ...st, restarted: false };
  start(lastServe.exePath, lastServe.env, { onExit: lastServe.onExit });
  return { ...(await wait(model, { check })), restarted: true };
}

/**
 * Tải model qua API của server đang chạy (model lưu theo OLLAMA_MODELS của server). Ollama gửi header và dòng
 * tiến độ ngay nên dùng fetch được; `onProgress(completed, total)` gọi theo từng dòng có `total`.
 */
async function pull(model, { fetchFn = fetch, onProgress } = {}) {
  const what = `Pull ${model}`;
  const res = await fetchFn(`${OLLAMA_URL}/api/pull`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok) throw new Error(`${what}: Ollama HTTP ${res.status} ${(await res.text()).slice(0, 200)}`.trim());
  let success = false;
  await forEachLine(res, (line) => {
    if (!line.trim()) return;
    const l = parseLine(line);
    if (l.error) throw new Error(`${what}: ${String(l.error).slice(0, 300)}`);
    if (l.status === 'success') success = true;
    if (onProgress && l.total) onProgress(l.completed || 0, l.total);
  });
  if (!success) throw new Error(`${what}: Ollama không báo success`);
}

/**
 * Gọi /api/chat (format json, temperature 0). B1: dùng `http.request` (không qua fetch/undici có giới hạn chờ header
 * 5 phút); Ollama chỉ gửi header sau khi xử lý xong prompt. Thời gian chờ duy nhất là `timeoutMs` tổng.
 * Trả { content, stats }; lỗi socket giữ nguyên `err.code` (ECONNREFUSED…).
 */
function chat(model, messages, { requestFn = http.request, timeoutMs = CHAT_TIMEOUT_MS, numCtx = NUM_CTX } = {}) {
  const body = JSON.stringify({ model, messages, stream: true, format: 'json', options: { temperature: 0, num_ctx: numCtx } });
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const settle = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const fail = (err) => settle(reject, err);
    const timer = setTimeout(() => {
      fail(new Error(`Ollama timeout sau ${timeoutMs} ms`));
      req.destroy();
    }, timeoutMs);
    req = requestFn(`${OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const firstByteMs = Date.now() - started;
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      const cut = (e) => Object.assign(new Error(`Chat: Ollama đóng kết nối giữa chừng${e ? ` (${e.message})` : ''}`),
        { code: e && e.code });
      res.on('error', (e) => fail(cut(e)));
      res.on('close', () => { if (!res.complete) fail(cut()); });
      res.on('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error(`Chat: Ollama HTTP ${res.statusCode} ${text.slice(0, 200)}`.trim());
          }
          const lines = parseNdjsonLines(text, 'Chat');
          const last = lines.find((l) => l.done === true);
          if (!last) throw new Error('Chat: Ollama đóng kết nối trước khi trả xong');
          const content = lines.map((l) => (l.message && typeof l.message.content === 'string' ? l.message.content : '')).join('');
          settle(resolve, {
            content,
            stats: {
              prompt_eval_count: last.prompt_eval_count, eval_count: last.eval_count,
              prompt_eval_duration: last.prompt_eval_duration, eval_duration: last.eval_duration,
              firstByteMs, totalMs: Date.now() - started,
            },
          });
        } catch (err) {
          fail(err);
        }
      });
    });
    req.on('error', fail);
    req.end(body);
  });
}

module.exports = {
  CHAT_TIMEOUT_MS, NUM_CTX, OLLAMA_HOST, OLLAMA_URL, chat, ensureRunning, isReady, parseNdjsonLines, pull, serve, waitReady,
};
