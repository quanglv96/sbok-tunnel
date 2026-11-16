'use strict';

const fs = require('fs');
const path = require('path');

/** BR-17 (#208): miền giá trị cấu hình đọc. Kiểm ở main process (biên tin cậy), Python kiểm lại. */
const SPEED_MIN = 0.7;
const SPEED_MAX = 1.2;
const PAUSE_MAX = 2000;
const MODELS = ['', 'v3nano']; // '' = v3 Turbo (48 kHz)
const BITRATES = ['64k', '96k', '128k'];
const DEFAULTS = Object.freeze({ speed: 1.0, pauseMs: 400, voice: 'Thiện Minh', model: '', bitrate: '96k' });
/** Mặc định PMO xác nhận (analysis.md mục 9.4). */
const PREVIEW_TEXT = 'Xin chào, đây là giọng đọc thử của Sách Nói.';

/** Tốc độ bước 0.05: so trên phần trăm để tránh sai số dấu phẩy động (1.05 * 100 = 105.00000000000001). */
function onSpeedStep(speed) {
  const pct = speed * 100;
  return Math.abs(pct - Math.round(pct)) < 1e-6 && Math.round(pct) % 5 === 0;
}

/**
 * `voices`: danh sách giọng của model đang chọn (null = chưa biết, chỉ cần chuỗi không rỗng; Python kiểm lại).
 * Trả `{ ok: true, value }` hoặc `{ ok: false, errors: { field: message } }`. Không nhận trường thừa.
 */
function validateTts(input, voices) {
  const t = input && typeof input === 'object' ? input : {};
  const errors = {};
  const speed = t.speed;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < SPEED_MIN || speed > SPEED_MAX || !onSpeedStep(speed)) {
    errors.speed = `Tốc độ phải từ ${SPEED_MIN} đến ${SPEED_MAX}, bước 0.05`;
  }
  if (!Number.isInteger(t.pauseMs) || t.pauseMs < 0 || t.pauseMs > PAUSE_MAX) {
    errors.pauseMs = `Khoảng lặng phải là số nguyên 0–${PAUSE_MAX} ms`;
  }
  if (!MODELS.includes(t.model)) errors.model = 'Model phải là v3 Turbo hoặc v3nano';
  if (!BITRATES.includes(t.bitrate)) errors.bitrate = `Bitrate phải là ${BITRATES.join(' / ')}`;
  const voice = typeof t.voice === 'string' ? t.voice.trim() : '';
  if (!voice || (Array.isArray(voices) && !voices.includes(voice))) errors.voice = 'Giọng không có trong danh sách của model';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { speed, pauseMs: t.pauseMs, voice, model: t.model, bitrate: t.bitrate } };
}

const envStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * #208: nguồn giá trị settings.json mục `tts` (UI) → env → mặc định. Giá trị env không kiểm ở đây (Python kiểm,
 * sai thì job lỗi có thông báo – BR-16); dùng `validateTts` trước khi chạy job để không đọc tiếp khi cấu hình sai.
 */
function resolveTts(settings, env = process.env) {
  const ui = (settings && settings.tts) || {};
  const pick = (key, envValue) => (ui[key] !== undefined ? ui[key] : envValue !== undefined ? envValue : DEFAULTS[key]);
  const num = (v) => (v === undefined ? undefined : Number(v));
  return {
    speed: pick('speed', num(envStr(env.SBOK_TTS_SPEED))),
    pauseMs: pick('pauseMs', num(envStr(env.SBOK_TTS_PAUSE_MS))),
    voice: pick('voice', envStr(env.SBOK_TTS_VOICE)),
    model: pick('model', env.VIENEU_MODEL === undefined ? undefined : env.VIENEU_MODEL.trim()),
    bitrate: pick('bitrate', envStr(env.SBOK_MP3_BITRATE)),
  };
}

/** Env cho tiến trình Python (tts_runner.py đọc sẵn các biến này). */
function ttsEnv(tts) {
  return {
    SBOK_TTS_SPEED: String(tts.speed),
    SBOK_TTS_PAUSE_MS: String(tts.pauseMs),
    SBOK_TTS_VOICE: tts.voice,
    VIENEU_MODEL: tts.model,
  };
}

/** File giọng do `tts_runner.py --prefetch` ghi theo model; không có = model chưa tải. */
function voicesFile(runtimeDir, model) {
  return path.join(runtimeDir, `vieneu-voices-${model || 'v3turbo'}.json`);
}

function readVoices(runtimeDir, model) {
  try {
    const list = JSON.parse(fs.readFileSync(voicesFile(runtimeDir, model), 'utf8'));
    return Array.isArray(list) && list.every((v) => typeof v === 'string') ? list : null;
  } catch {
    return null;
  }
}

/**
 * Xử lý IPC màn cấu hình đọc ở main process (renderer không được tin). `prefetch(model)`: tải model + ghi danh sách
 * giọng; `synthPreview(tts, text)`: trả đường dẫn MP3 nghe thử. `store`: { readSettings, writeSettings }.
 */
function createTtsController({ settingsFile, runtimeDir, isReady, isBusy, prefetch, synthPreview, store,
  env = process.env, log = console.log, readFile = fs.readFileSync }) {
  let previewing = false;
  const current = () => resolveTts(store.readSettings(settingsFile()), env);
  const blocked = () => (!isReady() ? 'Môi trường xử lý chưa sẵn sàng' : isBusy() ? 'Đang có job, thử lại khi job xong' : null);

  return {
    get() {
      const tts = current();
      return { tts, voices: readVoices(runtimeDir(), tts.model), models: MODELS, bitrates: BITRATES };
    },
    voices: (model) => (MODELS.includes(model) ? readVoices(runtimeDir(), model) : null),
    /** Lưu vào settings.json mục `tts`; áp dụng từ job kế tiếp. Model chưa có cache -> tải trước, lỗi thì không lưu. */
    async save(input) {
      const model = input && input.model;
      if (!MODELS.includes(model)) return validateTts(input, null);
      let voices = readVoices(runtimeDir(), model);
      if (!voices) {
        const why = blocked();
        if (why) return { ok: false, errors: { model: why } };
        try {
          await prefetch(model);
        } catch (err) {
          return { ok: false, errors: { model: err.message } };
        }
        voices = readVoices(runtimeDir(), model);
        if (!voices) return { ok: false, errors: { model: 'Tải model xong nhưng không đọc được danh sách giọng' } };
      }
      const checked = validateTts(input, voices);
      if (!checked.ok) return { ...checked, voices };
      store.writeSettings(settingsFile(), { ...store.readSettings(settingsFile()), tts: checked.value });
      log('[tts] Đã lưu cấu hình đọc, áp dụng từ job kế tiếp');
      return { ok: true, value: checked.value, voices };
    },
    /** "Nghe thử" câu mẫu bằng cấu hình đang chọn (chưa cần lưu); chặn khi có job hoặc chưa ready. */
    async preview(input) {
      const why = blocked();
      if (why) return { ok: false, error: why };
      const voices = MODELS.includes(input && input.model) ? readVoices(runtimeDir(), input.model) : null;
      const checked = validateTts(input, voices);
      if (!checked.ok) return { ok: false, errors: checked.errors };
      if (!voices) return { ok: false, error: 'Model chưa tải: bấm Lưu để tải model trước' };
      if (previewing) return { ok: false, error: 'Đang đọc thử' };
      previewing = true;
      try {
        const mp3 = await synthPreview(checked.value, PREVIEW_TEXT);
        return { ok: true, audio: `data:audio/mpeg;base64,${readFile(mp3).toString('base64')}` };
      } catch (err) {
        return { ok: false, error: err.message };
      } finally {
        previewing = false;
      }
    },
  };
}

module.exports = {
  BITRATES, DEFAULTS, MODELS, PAUSE_MAX, PREVIEW_TEXT, SPEED_MAX, SPEED_MIN,
  createTtsController, readVoices, resolveTts, ttsEnv, validateTts, voicesFile,
};
