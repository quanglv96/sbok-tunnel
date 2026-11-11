'use strict';

const fs = require('fs');
const path = require('path');
const { runScan } = require('./sandbox/scanWorker');
const { extractText } = require('./extract/pdfText');
const { splitChapters } = require('./extract/chapterSplitter');
const { synthesize } = require('./tts/ttsRunner');

/**
 * Xử lý 1 job: sandbox (BR-4) -> trích text + tách chương (BR-8) -> TTS từng chương -> kiểm quota -> đẩy R2 -> báo
 * backend. PDF và .txt tạm luôn bị xoá; MP3 trong cache chỉ xoá khi đã lên R2 (BR-10: lỗi R2 thì giữ để thử lại).
 */
async function processJob(job, { config, backend, uploader, log = console.log, deps = {} }) {
  const scan = deps.runScan || runScan;
  const extract = deps.extractText || extractText;
  const tts = deps.synthesize || synthesize;
  const { taskId, pdfPath, fileName } = job;
  const textDir = path.join(config.jobsDir, taskId);
  const mp3Dir = path.join(config.cacheDir, taskId);
  try {
    await backend.progress(taskId, 'VERIFYING');
    const violation = await scan(pdfPath);
    if (violation) {
      log(`Task ${taskId}: VI PHẠM ${violation}, huỷ xử lý`);
      await backend.violation(taskId, violation);
      return;
    }

    await backend.progress(taskId, 'PARSING');
    const { text, title, author } = await extract(pdfPath);
    const chapters = splitChapters(text);
    if (chapters.length === 0) {
      await backend.failed(taskId, 'Không trích được chữ từ PDF (có thể là ảnh scan)');
      return;
    }

    await backend.progress(taskId, 'TTS_PROCESSING');
    fs.mkdirSync(textDir, { recursive: true });
    fs.mkdirSync(mp3Dir, { recursive: true });
    const results = [];
    for (const ch of chapters) {
      const txt = path.join(textDir, `${ch.index}.txt`);
      const mp3 = path.join(mp3Dir, `${ch.index}.mp3`);
      fs.writeFileSync(txt, ch.text, 'utf8');
      const { durationSec } = await tts(config, txt, mp3, log);
      results.push({ ...ch, mp3, sizeBytes: fs.statSync(mp3).size, durationSec });
    }

    const total = results.reduce((s, r) => s + r.sizeBytes, 0);
    if (!(await backend.quotaOk(total))) {
      await backend.failed(taskId, 'Kho lưu trữ đã đầy, tạm ngưng nhận sách mới');
      return;
    }
    try {
      for (const r of results) {
        r.r2Key = `books/${taskId}/${r.index}.mp3`;
        await uploader.upload(r.r2Key, r.mp3);
      }
    } catch (err) {
      log(`Task ${taskId}: đẩy R2 thất bại sau 3 lần (${err.message}); MP3 giữ ở ${mp3Dir}`);
      await backend.failed(taskId, 'Không đẩy được audio lên kho lưu trữ, vui lòng thử lại sau');
      return;
    }

    const bookTitle = (title || fileName.replace(/\.pdf$/i, '') || 'Không tên').slice(0, 500);
    await backend.complete(taskId, bookTitle, author ? author.slice(0, 300) : null, results.map((r) => ({
      index: r.index, title: r.title, r2Key: r.r2Key, sizeBytes: r.sizeBytes, durationSec: r.durationSec,
    })));
    fs.rmSync(mp3Dir, { recursive: true, force: true });
    log(`Task ${taskId}: hoàn tất ${results.length} chương`);
  } catch (err) {
    log(`Task ${taskId}: lỗi ${err.message}`);
    await backend.failed(taskId, 'Xử lý thất bại').catch(() => {});
  } finally {
    fs.rmSync(pdfPath, { force: true });
    fs.rmSync(textDir, { recursive: true, force: true });
  }
}

module.exports = { processJob };
