'use strict';

const fs = require('fs');
const path = require('path');
const { runScan } = require('./sandbox/scanWorker');
const { extractText } = require('./extract/pdfText');
const { splitChapters } = require('./extract/chapterSplitter');
const { synthesizeBatch } = require('./tts/ttsRunner');
const { validateTts } = require('./ttsSettings');
const { MAX_RETRIES, TtsError, nextRetry, readJob, removeJob, saveJob } = require('./retryQueue');

/** BR-22: backendClient ném lỗi có cờ `rejected` khi callback nhận 404/401/409. */
const isRejected = (err) => Boolean(err && err.rejected);

/**
 * BR-22: dừng job khi backend từ chối task: không gọi callback nào nữa, huỷ hẹn đọc tiếp, xoá `job.json`,
 * giữ MP3 + txt, log một dòng lý do.
 */
function stopJob(taskId, err, { config, log = console.log, cancelRetry }) {
  if (cancelRetry) cancelRetry(taskId);
  removeJob(config.jobsDir, taskId);
  log(`Task ${taskId}: dừng job vì backend trả HTTP ${err.status} (task không tồn tại, sai token hoặc đã kết thúc); `
    + 'giữ MP3 và txt');
}

/** "Chương 2/5 · 40% · tổng 25%": tiến độ chương hiện tại và cả sách (theo số ký tự). */
function progressText(label, chapterRatio, doneChars, totalChars) {
  const pct = (r) => Math.min(100, Math.floor(r * 100));
  return `${label} · ${pct(chapterRatio)}% · tổng ${pct(totalChars ? doneChars / totalChars : 0)}%`;
}

/**
 * #151: đầu mỗi chương đọc tên sách và tên chương. "Giới thiệu" đã có bìa (tên sách) nên đọc nguyên văn;
 * "Toàn bộ" (không tách được chương) chỉ đọc tên sách.
 */
function spokenText(bookTitle, ch) {
  if (ch.title === 'Giới thiệu') return ch.text;
  const sentence = (s) => `${s.trim().replace(/[\s.:;,\-–—]+$/, '')}.`;
  const head = ch.title === 'Toàn bộ' ? sentence(bookTitle) : `${sentence(bookTitle)} ${sentence(ch.title)}`;
  return `${head}\n${ch.text}`;
}

/**
 * Xử lý 1 job: sandbox (BR-4) -> trích text + tách chương (BR-8) -> ghi txt + `job.json` (chụp cấu hình đọc) -> TTS,
 * báo từng chương (BR-18). `job.resume` = lượt đọc tiếp từ `job.json`. PDF luôn bị xoá; txt chương giữ lâu dài
 * (BR-16 v13); MP3 giữ lâu dài ở `{cacheDir}/{taskId}` (BR-19, chỉ đẩy R2 khi có người nghe – `uploadChapter`).
 * Callback bị từ chối (404/401/409) → `stopJob` (BR-22).
 * `ctx`: { config, backend, log, deps, tts (cấu hình đọc đã resolve), scheduleRetry(state), cancelRetry(taskId) }.
 */
async function processJob(job, ctx) {
  const { config, backend, log = console.log, deps = {} } = ctx;
  if (job.resume) return resumeJob(job.taskId, ctx);
  const scan = deps.runScan || runScan;
  const extract = deps.extractText || extractText;
  const { taskId, pdfPath, fileName } = job;
  const textDir = path.join(config.jobsDir, taskId);
  let state;
  try {
    await backend.progress(taskId, 'VERIFYING');
    const violation = await scan(pdfPath);
    if (violation) {
      log(`Task ${taskId}: VI PHẠM ${violation}, huỷ xử lý`);
      await backend.violation(taskId, violation);
      return;
    }

    log(`Task ${taskId}: qua kiểm tra an toàn, đang trích chữ`);
    await backend.progress(taskId, 'PARSING');
    const { text, title, author } = await extract(pdfPath);
    const chapters = splitChapters(text);
    const bookTitle = (title || fileName.replace(/\.pdf$/i, '') || 'Không tên').slice(0, 500);
    log(`Task ${taskId}: ${text.length} ký tự, ${chapters.length} chương`);
    if (chapters.length === 0) {
      await backend.failed(taskId, 'Không trích được chữ từ PDF (có thể là ảnh scan)');
      return;
    }
    // BR-16/BR-18: cấu hình đọc sai -> lỗi ngay, không đọc tiếp
    const checked = ctx.tts ? validateTts(ctx.tts, null) : { ok: true };
    if (!checked.ok) {
      await backend.failed(taskId, `Cấu hình đọc không hợp lệ: ${Object.values(checked.errors).join('; ')}`);
      return;
    }

    fs.mkdirSync(textDir, { recursive: true });
    for (const ch of chapters) fs.writeFileSync(path.join(textDir, `${ch.index}.txt`), spokenText(bookTitle, ch), 'utf8');
    state = {
      taskId, fileName, bookTitle, author: author ? author.slice(0, 300) : null,
      chapters: chapters.map((ch) => ({ index: ch.index, title: ch.title, chars: ch.text.length })),
      done: {}, reported: [], attempt: 0, nextRetryAt: null, tts: ctx.tts || null,
    };
    saveJob(config.jobsDir, state);
  } catch (err) {
    if (isRejected(err)) {
      stopJob(taskId, err, ctx);
      return;
    }
    log(`Task ${taskId}: lỗi ${err.message}`);
    await backend.failed(taskId, 'Xử lý thất bại').catch(() => {});
    fs.rmSync(textDir, { recursive: true, force: true });
    return;
  } finally {
    fs.rmSync(pdfPath, { force: true });
  }
  if (state) await runTts(state, ctx);
}

/** Lượt đọc tiếp: nạp `job.json`, chỉ đọc chương chưa xong, dùng cấu hình đã chụp lúc job bắt đầu (BR-17). */
async function resumeJob(taskId, ctx) {
  const { config, log = console.log } = ctx;
  const state = readJob(config.jobsDir, taskId);
  if (!state) {
    log(`Đọc tiếp ${taskId}: không có hoặc hỏng job.json, bỏ qua`);
    return;
  }
  state.nextRetryAt = null;
  saveJob(config.jobsDir, state);
  log(`Task ${taskId}: đọc tiếp lần ${state.attempt}/${MAX_RETRIES}`);
  await runTts(state, ctx);
}

async function runTts(state, ctx) {
  const { config, backend, log = console.log, deps = {} } = ctx;
  const tts = deps.synthesizeBatch || synthesizeBatch;
  const { taskId, chapters } = state;
  const textDir = path.join(config.jobsDir, taskId);
  const mp3Dir = path.join(config.cacheDir, taskId);
  const save = () => saveJob(config.jobsDir, state);
  // BR-22: callback bị từ chối → ghi lại lỗi, không gửi gì thêm, dừng TTS ở chương kế tiếp
  let stopped = null;
  const halt = (err) => {
    if (!stopped) stopped = err;
  };
  const sends = [];
  const send = (ch) => {
    if (stopped) return Promise.resolve();
    const d = state.done[ch.index];
    const p = backend.chapterDone(taskId, state.bookTitle, state.author,
      { index: ch.index, title: ch.title, sizeBytes: d.sizeBytes, durationSec: d.durationSec })
      .then((ok) => {
        if (!ok) log(`Task ${taskId}: backend không nhận chương ${ch.index}, sẽ gửi lại trước khi chốt`);
        if (ok && !state.reported.includes(ch.index)) {
          state.reported.push(ch.index);
          save();
        }
      })
      .catch((err) => (isRejected(err) ? halt(err)
        : log(`Task ${taskId}: báo chương ${ch.index} lỗi (${err.message}), sẽ gửi lại`)));
    sends.push(p);
    return p;
  };
  // #133: báo người dùng đang ở chương nào, bao nhiêu %; lỗi gửi tiến độ không được làm hỏng job
  const report = (detail) => (stopped ? Promise.resolve()
    : backend.progress(taskId, 'TTS_PROCESSING', detail).catch((err) => { if (isRejected(err)) halt(err); }));
  const checkStopped = () => {
    if (stopped) throw stopped;
  };
  try {
    const pending = chapters.filter((c) => !state.done[c.index]);
    const totalChars = chapters.reduce((s, c) => s + c.chars, 0);
    let doneChars = totalChars - pending.reduce((s, c) => s + c.chars, 0);
    await report(state.attempt ? `Đọc tiếp từ chương ${chapters.indexOf(pending[0]) + 1}/${chapters.length}`
      : `${chapters.length} chương, ${totalChars} ký tự`);
    checkStopped();
    if (pending.length) {
      fs.mkdirSync(mp3Dir, { recursive: true });
      // P1 (AC-23): gọi TTS 1 lần cho các chương còn lại (model nạp 1 lần)
      const items = pending.map((c) => ({ in: path.join(textDir, `${c.index}.txt`), out: path.join(mp3Dir, `${c.index}.mp3`) }));
      let cur = 0;
      let startedAt = Date.now();
      const label = () => `Chương ${chapters.indexOf(pending[cur]) + 1}/${chapters.length}`;
      const ttsLog = (line) => {
        log(line);
        const c = /chapter (\d+)\/(\d+)/.exec(line);
        if (c) {
          cur = Math.min(Number(c[1]) - 1, pending.length - 1);
          startedAt = Date.now();
          log(`Task ${taskId}: TTS ${label().toLowerCase()} (${pending[cur].chars} ký tự)`);
          void report(progressText(label(), 0, doneChars, totalChars));
        }
        const m = /chunk (\d+)\/(\d+)/.exec(line);
        if (m) void report(progressText(label(), m[1] / m[2], doneChars + (pending[cur].chars * m[1]) / m[2], totalChars));
      };
      const onChapterDone = (i, { durationSec }) => {
        checkStopped(); // ném lỗi → ttsRunner kill tiến trình Python, không đọc chương sau
        const ch = pending[i];
        doneChars += ch.chars;
        state.done[ch.index] = { sizeBytes: fs.statSync(items[i].out).size, durationSec };
        save();
        log(`Task ${taskId}: xong chương ${chapters.indexOf(ch) + 1}/${chapters.length} sau ${Math.round((Date.now() - startedAt) / 1000)} s`);
        void send(ch);
      };
      try {
        await tts(state.tts ? { ...config, tts: state.tts } : config, items, ttsLog, onChapterDone);
      } catch (err) {
        checkStopped();
        throw new TtsError(err.message);
      }
    }
    const left = chapters.filter((c) => !state.done[c.index]).length;
    if (left) throw new TtsError(`TTS chỉ xong ${chapters.length - left}/${chapters.length} chương`);

    // BR-18: gửi lại chương chưa báo trước khi chốt
    await Promise.all(sends);
    for (const ch of chapters) if (!state.reported.includes(ch.index)) await send(ch);
    checkStopped();
    await backend.complete(taskId);
    log(`Task ${taskId}: hoàn tất ${chapters.length} chương, MP3 và txt giữ ở ${mp3Dir}, ${textDir}`);
    removeJob(config.jobsDir, taskId);
  } catch (err) {
    await Promise.all(sends);
    if (isRejected(err) || stopped) {
      stopJob(taskId, stopped || err, ctx);
      return;
    }
    const next = err instanceof TtsError ? nextRetry(state.attempt) : null;
    try {
      if (next) {
        state.attempt = next.attempt;
        state.nextRetryAt = next.nextRetryAt;
        save();
        const msg = `Đọc tiếp lần ${next.attempt}/${MAX_RETRIES} sau ${next.minutes} phút`;
        log(`Task ${taskId}: lỗi TTS (${err.message}); ${msg.toLowerCase()}`);
        await backend.progress(taskId, 'RETRYING', msg).catch((e) => { if (isRejected(e)) throw e; });
        ctx.scheduleRetry(state);
        return;
      }
      log(`Task ${taskId}: lỗi ${err.message}`);
      const msg = err instanceof TtsError ? `Đọc lỗi, đã đọc tiếp ${MAX_RETRIES} lần không được` : 'Xử lý thất bại';
      await backend.failed(taskId, msg).catch((e) => { if (isRejected(e)) throw e; });
      removeJob(config.jobsDir, taskId);
    } catch (e) {
      stopJob(taskId, e, ctx);
    }
  }
}

/**
 * BR-19/BR-10: đẩy MP3 chương lên R2 khi sbok-service yêu cầu (`uploader.upload` tự retry 3 lần có backoff).
 * Không còn file → `missing=true`. Không xoá MP3 sau khi đẩy.
 */
async function uploadChapter(taskId, index, ctx) {
  try {
    await doUpload(taskId, index, ctx);
  } catch (err) {
    if (!isRejected(err)) throw err;
    stopJob(taskId, err, ctx);
  }
}

async function doUpload(taskId, index, { config, backend, uploader, log = console.log }) {
  const mp3 = path.join(config.cacheDir, taskId, `${index}.mp3`);
  log(`Đẩy chương ${taskId}/${index}: bắt đầu`);
  if (!fs.existsSync(mp3)) {
    log(`Đẩy chương ${taskId}/${index}: không còn MP3`);
    await backend.chapterUploadFailed(taskId, index, true);
    return;
  }
  const r2Key = `books/${taskId}/${index}.mp3`;
  try {
    await uploader.upload(r2Key, mp3);
  } catch (err) {
    log(`Đẩy chương ${taskId}/${index} lên R2 thất bại (${err.message}); MP3 giữ ở ${mp3}`);
    await backend.chapterUploadFailed(taskId, index, false);
    return;
  }
  await backend.chapterUploaded(taskId, index, r2Key, fs.statSync(mp3).size);
  log(`Đẩy chương ${taskId}/${index} lên R2 xong`);
}

module.exports = { processJob, progressText, spokenText, uploadChapter };
