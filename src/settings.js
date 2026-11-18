'use strict';

const fs = require('fs');
const path = require('path');

/** FEAT-007 (BR-1/BR-3): chế độ tách chương; '' = chưa chọn (tự chọn llm nếu Ollama sẵn sàng). */
const SPLIT_MODES = ['', 'heuristic', 'llm'];
const DEFAULT_LLM_MODEL = 'qwen2.5:3b';
// Tên model Ollama ("qwen2.5:3b", "library/qwen2.5:7b-instruct"); kiểm ở main process trước khi truyền cho Ollama
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]*(?::[A-Za-z0-9._-]+)?$/;

/** BR-15: đọc {userData}/settings.json. Không có hoặc hỏng → {} (coi như chưa cài, không crash). */
function readSettings(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

/** Ghi file tạm rồi rename để không để lại settings.json dở dang. */
function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');
const validMode = (v) => ['heuristic', 'llm'].includes(trimmed(v).toLowerCase());
const validModel = (v) => trimmed(v).length > 0 && trimmed(v).length <= 100 && MODEL_RE.test(trimmed(v));

/**
 * FEAT-007 (BR-1, AC-4): settings.json mục `split` (UI) → env (`SBOK_SPLIT_MODE`, `SBOK_LLM_MODEL`) → mặc định.
 * Giá trị lạ hoặc rỗng = chưa chọn ở nguồn đó. `source` = nguồn của mode (`ui`/`env`/`default`) để log (AC-14).
 */
function resolveSplit(settings, env = process.env) {
  const ui = (settings && settings.split) || {};
  const modeIdx = [ui.mode, env.SBOK_SPLIT_MODE].findIndex(validMode);
  const mode = modeIdx < 0 ? '' : trimmed([ui.mode, env.SBOK_SPLIT_MODE][modeIdx]).toLowerCase();
  const model = [ui.model, env.SBOK_LLM_MODEL].find(validModel);
  return { mode, model: model ? trimmed(model) : DEFAULT_LLM_MODEL, source: ['ui', 'env'][modeIdx] || 'default' };
}

/** Kiểm giá trị UI gửi lên (renderer không được tin). Model rỗng = mặc định. */
function validateSplit(input) {
  const s = input && typeof input === 'object' ? input : {};
  const errors = {};
  const mode = trimmed(s.mode);
  if (!SPLIT_MODES.includes(mode)) errors.mode = 'Chế độ phải là Tự động, Theo tiêu đề hoặc LLM';
  const model = trimmed(s.model) || DEFAULT_LLM_MODEL;
  if (!validModel(model)) errors.model = 'Tên model Ollama không hợp lệ (ví dụ qwen2.5:3b)';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { mode, model } };
}

module.exports = { DEFAULT_LLM_MODEL, SPLIT_MODES, readSettings, resolveSplit, validateSplit, writeSettings };
