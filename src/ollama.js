'use strict';

const { spawn } = require('child_process');

/** FEAT-007: Ollama chỉ nghe local; hằng số, không đọc từ env/IPC. */
const OLLAMA_HOST = '127.0.0.1:11434';
const OLLAMA_URL = `http://${OLLAMA_HOST}`;
const JSON_HEADERS = { 'content-type': 'application/json' };
// Ngữ cảnh đủ cho phần đầu mọi trang của sách dài với model 3b (KV cache vẫn vừa máy ít RAM)
const NUM_CTX = 16384;

/**
 * Đọc hết body NDJSON (stream: true để không vướng headersTimeout 5 phút của fetch khi model chạy lâu).
 * Dòng có `error` → ném lỗi.
 */
async function readNdjson(res, what) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: Ollama HTTP ${res.status} ${text.slice(0, 200)}`.trim());
  const lines = text.split('\n').filter((l) => l.trim()).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return {};
    }
  });
  const failed = lines.find((l) => l.error);
  if (failed) throw new Error(`${what}: ${String(failed.error).slice(0, 300)}`);
  return lines;
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

/** Chạy `ollama serve` nền (không shell, không cửa sổ). Lỗi spawn chỉ làm waitReady trả running false. */
function serve(exePath, env) {
  const child = spawn(exePath, ['serve'], { env, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  return child;
}

/** Tải model qua API của server đang chạy (model lưu theo OLLAMA_MODELS của server). */
async function pull(model, { fetchFn = fetch } = {}) {
  const res = await fetchFn(`${OLLAMA_URL}/api/pull`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ model, stream: true }),
  });
  const lines = await readNdjson(res, `Pull ${model}`);
  if (!lines.some((l) => l.status === 'success')) throw new Error(`Pull ${model}: Ollama không báo success`);
}

/** Gọi /api/chat (format json, temperature 0); trả nội dung trả lời ghép từ các dòng stream. */
async function chat(model, messages, { fetchFn = fetch, timeoutMs = 10 * 60_000 } = {}) {
  const res = await fetchFn(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ model, messages, stream: true, format: 'json', options: { temperature: 0, num_ctx: NUM_CTX } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const lines = await readNdjson(res, 'Chat');
  return lines.map((l) => (l.message && typeof l.message.content === 'string' ? l.message.content : '')).join('');
}

module.exports = { NUM_CTX, OLLAMA_HOST, OLLAMA_URL, chat, isReady, pull, serve, waitReady };
