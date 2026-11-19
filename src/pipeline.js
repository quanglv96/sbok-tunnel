'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runScan } = require('./sandbox/scanWorker');
const { extractText } = require('./extract/pdfText');
const { splitChapters } = require('./extract/chapterSplitter');
const { splitWithLlm } = require('./extract/llmSplitter');
const { isReady: ollamaReady, ensureRunning: ollamaEnsureRunning } = require('./ollama');
const { notifyChapterSplitFailed } = require('./adminAlert');
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

/** AC-14/BR-14: message lỗi kèm mã nguyên nhân gốc (ECONNREFUSED, UND_ERR_HEADERS_TIMEOUT…) nếu message chưa có. */
function errText(err) {
  const msg = String((err && err.message) || err);
  const code = err && (err.code || (err.cause && err.cause.code));
  return code && !msg.includes(code) ? `${msg} (${code})` : msg;
}

/** AC-14: log một bước: "{prefix}: [name] bắt đầu" / "xong (N ms, extra)" / "lỗi (N ms): message (code)". */
function step(log, prefix, name) {
  const t0 = Date.now();
  log(`${prefix}: [${name}] bắt đầu`);
  return {
    done: (extra) => log(`${prefix}: [${name}] xong (${Date.now() - t0} ms${extra ? `, ${extra}` : ''})`),
    fail: (err) => log(`${prefix}: [${name}] lỗi (${Date.now() - t0} ms): ${errText(err)}`),
  };
}

/** Chạy `fn` trong một bước có log; `extra(kết quả)` = số liệu ghi khi xong. */
async function timed(log, prefix, name, fn, extra = () => '') {
  const s = step(log, prefix, name);
  try {
    const r = await fn();
    s.done(extra(r));
    return r;
  } catch (err) {
    s.fail(err);
    throw err;
  }
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
 * BR-20: tên file chương (không đuôi) `003 - Tiêu đề`: bỏ ký tự cấm Windows và ký tự điều khiển, gộp khoảng trắng,
 * cắt 80 ký tự, bỏ dấu chấm/khoảng trắng cuối; tiêu đề rỗng → chỉ số thứ tự.
 */
function chapterFileName(index, title) {
  const num = String(index).padStart(3, '0');
  const clean = String(title || '').replace(/\s+/g, ' ').replace(/[\\/:*?"<>|]|\p{Cc}/gu, '').replace(/\s+/g, ' ').trim()
    .slice(0, 80).replace(/[.\s]+$/, '');
  return clean ? `${num} - ${clean}` : num;
}

/**
 * BR-20: MP3 của chương trong thư mục cache: `003.mp3`/`003 - Tiêu đề.mp3` (job mới) hoặc `{index}.mp3` (job cũ).
 * Dò theo thư mục vì job.json đã bị xoá khi job hoàn tất (upload chạy khi có người nghe).
 */
function chapterMp3(dir, index) {
  const num = String(index).padStart(3, '0');
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    // không còn thư mục → coi như không còn MP3
  }
  const hit = files.find((f) => f === `${num}.mp3` || (f.startsWith(`${num} - `) && f.endsWith('.mp3')));
  return path.join(dir, hit || `${index}.mp3`);
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
  let splitState;
  const prefix = `Task ${taskId}`;
  try {
    await backend.progress(taskId, 'VERIFYING');
    const violation = await timed(log, prefix, 'kiểm tra an toàn', () => scan(pdfPath), (v) => (v ? 'vi phạm' : 'qua'));
    if (violation) {
      log(`Task ${taskId}: VI PHẠM ${violation}, huỷ xử lý`);
      await backend.violation(taskId, violation);
      return;
    }

    await backend.progress(taskId, 'PARSING');
    const { text, title, author, pages } = await timed(log, prefix, 'trích chữ', () => extract(pdfPath),
      (r) => `${Array.isArray(r.pages) ? r.pages.length : '?'} trang, ${r.text.length} ký tự`);
    const base = {
      taskId, fileName, bookTitle: (title || fileName.replace(/\.pdf$/i, '') || 'Không tên').slice(0, 500),
      author: author ? author.slice(0, 300) : null, tts: ctx.tts || null,
    };
    if (await useLlm(ctx, prefix)) {
      // FEAT-007 (BR-6): lưu text từng trang trước khi PDF bị xoá để lượt thử lại tách được
      fs.mkdirSync(textDir, { recursive: true });
      fs.writeFileSync(pagesFile(config.jobsDir, taskId), JSON.stringify(pages || [text]), 'utf8');
      splitState = { ...base, phase: 'split', model: ctx.split.model, splitAttempt: 0, chapters: [], attempt: 0, nextRetryAt: null };
      saveJob(config.jobsDir, splitState);
    } else {
      const chapters = await timed(log, prefix, 'tách chương heuristic', () => splitChapters(text), (c) => `${c.length} chương`);
      state = await prepareChapters(base, chapters, text.length, ctx);
    }
  } catch (err) {
    if (isRejected(err)) {
      stopJob(taskId, err, ctx);
      return;
    }
    log(`Task ${taskId}: lỗi ${err.message}`);
    await backend.failed(taskId, 'Xử lý thất bại').catch(() => {});
    removeJob(config.jobsDir, taskId); // BR-16 v13 (TC-144): giữ txt đã ghi, chỉ bỏ job.json để không đọc tiếp
    fs.rmSync(pagesFile(config.jobsDir, taskId), { force: true });
    return;
  } finally {
    fs.rmSync(pdfPath, { force: true });
  }
  if (splitState) return runLlmSplit(splitState, ctx);
  if (state) await runTts(state, ctx);
}

/**
 * Ghi txt chương + `job.json` để TTS. Không có chương hoặc cấu hình đọc sai → báo failed, trả null.
 * `base`: { taskId, fileName, bookTitle, author, tts }.
 */
async function prepareChapters(base, chapters, chars, ctx) {
  const { config, backend, log = console.log } = ctx;
  const { taskId, bookTitle } = base;
  log(`Task ${taskId}: ${chars} ký tự, ${chapters.length} chương`);
  if (chapters.length === 0) {
    await backend.failed(taskId, 'Không trích được chữ từ PDF (có thể là ảnh scan)');
    return null;
  }
  // BR-16/BR-18: cấu hình đọc sai -> lỗi ngay, không đọc tiếp
  const checked = base.tts ? validateTts(base.tts, null) : { ok: true };
  if (!checked.ok) {
    await backend.failed(taskId, `Cấu hình đọc không hợp lệ: ${Object.values(checked.errors).join('; ')}`);
    return null;
  }

  const textDir = path.join(config.jobsDir, taskId);
  return timed(log, `Task ${taskId}`, 'ghi txt + job.json', () => {
    fs.mkdirSync(textDir, { recursive: true });
    const names = chapters.map((ch) => chapterFileName(ch.index, ch.title));
    chapters.forEach((ch, i) => fs.writeFileSync(path.join(textDir, `${names[i]}.txt`), spokenText(bookTitle, ch), 'utf8'));
    const state = {
      taskId, fileName: base.fileName, bookTitle, author: base.author,
      chapters: chapters.map((ch, i) => ({ index: ch.index, title: ch.title, name: names[i], chars: ch.text.length })),
      done: {}, reported: [], attempt: 0, nextRetryAt: null, tts: base.tts,
    };
    saveJob(config.jobsDir, state);
    return state;
  }, (st) => `${st.chapters.length} chương, ${st.chapters.reduce((n, c) => n + c.chars, 0)} ký tự`);
}

/** FEAT-007: text từng trang lưu cho lượt thử lại tách chương LLM (BR-6); xoá khi tách xong hoặc task kết thúc. */
const pagesFile = (jobsDir, taskId) => path.join(jobsDir, taskId, 'pages.json');

function readPages(jobsDir, taskId) {
  try {
    const pages = JSON.parse(fs.readFileSync(pagesFile(jobsDir, taskId), 'utf8'));
    return Array.isArray(pages) && pages.length ? pages.map((p) => String(p ?? '')) : null;
  } catch {
    return null;
  }
}

/**
 * FEAT-007 (BR-2, AC-3): mode đã chọn thì theo đó; chưa chọn thì llm khi Ollama chạy và có model.
 * Không có `ctx.split` (lượt đọc tiếp, caller cũ) = logic hiện tại.
 */
async function useLlm(ctx, prefix) {
  const split = ctx.split;
  const s = step(ctx.log || console.log, prefix, 'chọn chế độ');
  if (!split || split.mode === 'heuristic' || split.mode === 'llm') {
    const mode = split ? split.mode : 'heuristic';
    s.done(`${mode}, nguồn ${split ? split.source || 'default' : 'mặc định'}`);
    return mode === 'llm';
  }
  const st = await ((ctx.deps && ctx.deps.ollamaReady) || ollamaReady)(split.model);
  const llm = st.running && st.hasModel;
  s.done(`${llm ? 'llm' : 'heuristic'}, tự động: running=${st.running}, hasModel=${st.hasModel}`);
  return llm;
}

/**
 * FEAT-007: tách chương bằng LLM từ pages.json rồi chạy TTS như cũ. Lỗi LLM → thử lại 1/5/15 phút (BR-6);
 * hết lượt → failed + báo admin, không chuyển sang logic hiện tại (BR-7).
 */
async function runLlmSplit(s, ctx) {
  const { config, backend, log = console.log, deps = {} } = ctx;
  const { taskId } = s;
  const cleanup = () => {
    removeJob(config.jobsDir, taskId);
    fs.rmSync(pagesFile(config.jobsDir, taskId), { force: true });
  };
  let state;
  try {
    const pages = readPages(config.jobsDir, taskId);
    if (!pages) {
      log(`Task ${taskId}: không đọc được pages.json, không tách chương được`);
      await backend.failed(taskId, 'Xử lý thất bại');
      cleanup();
      return;
    }
    const attempt = s.splitAttempt ? `thử lại lần ${s.splitAttempt}/${MAX_RETRIES}` : 'lần đầu';
    // Ollama có thể đã sập ở lượt trước (ECONNRESET) → khởi động lại trước khi gọi, không thì mọi lượt đều ECONNREFUSED
    const t0 = Date.now();
    const ol = await (deps.ollamaEnsureRunning || ollamaEnsureRunning)(s.model);
    if (ol.restarted) {
      log(`Task ${taskId}: Ollama không chạy, đã khởi động lại (${Date.now() - t0} ms, running=${ol.running}, hasModel=${ol.hasModel})`);
    }
    const st = step(log, `Task ${taskId}`, `tách chương LLM ${s.model}, ${attempt}`);
    let chapters;
    try {
      const r = await (deps.splitWithLlm || splitWithLlm)(pages, { model: s.model });
      chapters = r.chapters;
      const x = r.stats || {};
      st.done(`${x.pages} trang, headingPages ${x.headingPages}, tocEntries ${x.tocEntries}, tocAdded ${x.tocAdded}, promptChars ${x.promptChars}, numCtx ${x.numCtx} (đã thử ${x.ctxTried}), firstByteMs ${x.firstByteMs}, `
        + `totalMs ${x.totalMs}, prompt_eval_count ${x.prompt_eval_count}, eval_count ${x.eval_count}, ${chapters.length} chương`);
    } catch (err) {
      st.fail(err);
      await llmFailed(s, err, ctx, cleanup);
      return;
    }
    fs.rmSync(pagesFile(config.jobsDir, taskId), { force: true });
    state = await prepareChapters(s, chapters, pages.reduce((n, p) => n + p.length, 0), ctx);
    if (!state) removeJob(config.jobsDir, taskId);
  } catch (err) {
    if (isRejected(err)) {
      stopJob(taskId, err, ctx);
      fs.rmSync(pagesFile(config.jobsDir, taskId), { force: true });
      return;
    }
    log(`Task ${taskId}: lỗi ${err.message}`);
    await backend.failed(taskId, 'Xử lý thất bại').catch(() => {});
    cleanup();
    return;
  }
  if (state) await runTts(state, ctx);
}

async function llmFailed(s, err, ctx, cleanup) {
  const { config, backend, log = console.log, deps = {} } = ctx;
  const { taskId } = s;
  const next = nextRetry(s.splitAttempt);
  if (next) {
    s.splitAttempt = next.attempt;
    s.nextRetryAt = next.nextRetryAt;
    saveJob(config.jobsDir, s);
    const msg = `Tách chương thử lại lần ${next.attempt}/${MAX_RETRIES} sau ${next.minutes} phút`;
    log(`Task ${taskId}: tách chương LLM lỗi (${errText(err)}); ${msg.toLowerCase()}`);
    await backend.progress(taskId, 'RETRYING', msg).catch((e) => { if (isRejected(e)) throw e; });
    ctx.scheduleRetry(s);
    return;
  }
  log(`Task ${taskId}: tách chương LLM lỗi sau ${MAX_RETRIES} lần thử lại (${errText(err)})`);
  await backend.failed(taskId, `Tách chương lỗi, đã thử lại ${MAX_RETRIES} lần không được`)
    .catch((e) => { if (isRejected(e)) throw e; });
  cleanup();
  await (deps.notifyAdmin || notifyChapterSplitFailed)(config, {
    taskId, bookTitle: s.bookTitle, model: s.model, attempts: MAX_RETRIES, error: err.message,
    host: os.hostname(), occurredAt: new Date().toISOString(),
  }, { log });
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
  // FEAT-007: job đang chờ thử lại tách chương LLM
  if (state.phase === 'split') return runLlmSplit(state, ctx);
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
    const t0 = Date.now();
    const p = backend.chapterDone(taskId, state.bookTitle, state.author,
      { index: ch.index, title: ch.title, sizeBytes: d.sizeBytes, durationSec: d.durationSec })
      .then((ok) => {
        log(`Task ${taskId}: [báo chương ${ch.index}] xong (${Date.now() - t0} ms, ${ok ? 'nhận' : 'không nhận'})`);
        if (!ok) log(`Task ${taskId}: backend không nhận chương ${ch.index}, sẽ gửi lại trước khi chốt`);
        if (ok && !state.reported.includes(ch.index)) {
          state.reported.push(ch.index);
          save();
        }
      })
      .catch((err) => (isRejected(err) ? halt(err)
        : log(`Task ${taskId}: báo chương ${ch.index} lỗi (${errText(err)}), sẽ gửi lại`)));
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
      // BR-20: job cũ (job.json không có name) dùng tên `{index}`
      const items = pending.map((c) => {
        const name = c.name ?? c.index;
        return { in: path.join(textDir, `${name}.txt`), out: path.join(mp3Dir, `${name}.mp3`) };
      });
      let cur = 0;
      let startedAt = Date.now();
      const label = () => `Chương ${chapters.indexOf(pending[cur]) + 1}/${chapters.length}`;
      const ttsLog = (line) => {
        log(line);
        const c = /chapter (\d+)\/(\d+)/.exec(line);
        if (c) {
          cur = Math.min(Number(c[1]) - 1, pending.length - 1);
          startedAt = Date.now();
          log(`Task ${taskId}: [TTS ${label().toLowerCase()}] bắt đầu (${pending[cur].chars} ký tự)`);
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
        log(`Task ${taskId}: [TTS chương ${chapters.indexOf(ch) + 1}/${chapters.length}] xong (${Date.now() - startedAt} ms, `
          + `${ch.chars} ký tự)`);
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
    await timed(log, `Task ${taskId}`, 'báo hoàn tất', () => backend.complete(taskId));
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
  const mp3 = chapterMp3(path.join(config.cacheDir, taskId), index);
  log(`Đẩy chương ${taskId}/${index}: bắt đầu`);
  if (!fs.existsSync(mp3)) {
    log(`Đẩy chương ${taskId}/${index}: không còn MP3`);
    await backend.chapterUploadFailed(taskId, index, true);
    return;
  }
  const r2Key = `books/${taskId}/${index}.mp3`;
  const t0 = Date.now();
  try {
    await uploader.upload(r2Key, mp3);
  } catch (err) {
    log(`Đẩy chương ${taskId}/${index} lên R2 thất bại (${Date.now() - t0} ms): ${errText(err)}; MP3 giữ ở ${mp3}`);
    await backend.chapterUploadFailed(taskId, index, false);
    return;
  }
  await backend.chapterUploaded(taskId, index, r2Key, fs.statSync(mp3).size);
  log(`Đẩy chương ${taskId}/${index} lên R2 xong (${Date.now() - t0} ms)`);
}

module.exports = { chapterFileName, processJob, progressText, spokenText, uploadChapter };
