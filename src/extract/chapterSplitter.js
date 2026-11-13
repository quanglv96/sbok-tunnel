'use strict';

// #139: số chương bằng chữ ("CHƯƠNG MỘT", "Chương Hai Mươi Mốt") hoặc La Mã ("CHƯƠNG IV"); hai dạng này phải theo sau
// là dấu ":" "." "-" hoặc hết dòng, để câu văn "Chương hai trình bày..." không bị nhận là tiêu đề.
const WORDS = ['một', 'hai', 'ba', 'bốn', 'tư', 'năm', 'lăm', 'sáu', 'bảy', 'tám', 'chín', 'mười', 'mươi', 'mốt', 'linh',
  'lẻ', 'trăm'];
const WORD = WORDS.flatMap((w) => [w, w[0].toUpperCase() + w.slice(1), w.toUpperCase()]).join('|');
const NUM = `\\d+|(?:(?:${WORD})(?:[ \\t]+(?:${WORD}))*|[IVXLC]+)(?=[ \\t]*(?:[:.\\-–—]|$))`;
const HEADING = new RegExp(`^[ \\t]*((Chương|CHƯƠNG|Chapter|CHAPTER)\\s+(${NUM})[^\\n]*)$`, 'gm');
const TOC_BODY_MAX = 200;

/** "Chương 3: Abc ..... 12" -> "chương 3" để so mục lục với chương thật. */
const headingKey = (m) => `${m[2]} ${m[3].replace(/\s+/g, ' ')}`.toLowerCase();

/**
 * BR-8: tách chương theo dòng bắt đầu bằng "Chương N" / "Chapter N" (N là số, chữ hoặc La Mã).
 * Không có tiêu đề nào -> 1 chương "Toàn bộ".
 * #135: trang bìa (chữ trước tiêu đề đầu) + mục lục (các tiêu đề đầu mà số chương còn xuất hiện lại phía sau) gộp
 * thành 1 chương "Giới thiệu"; dòng mục lục bỏ dấu chấm dẫn và số trang.
 */
function splitChapters(text) {
  // NFC: chữ trích từ PDF có thể ở dạng dấu tổ hợp (NFD), khi đó "Chương" không khớp
  const normalized = (text || '').normalize('NFC').replace(/\r\n?/g, '\n');
  let matches = [...normalized.matchAll(HEADING)];
  if (matches.length === 0) {
    const body = normalized.trim();
    return body ? [{ index: 1, title: 'Toàn bộ', text: body }] : [];
  }
  const isTocEntry = (i) => {
    const m = matches[i];
    const next = i + 1 < matches.length ? matches[i + 1].index : normalized.length;
    const short = normalized.slice(m.index + m[0].length, next).trim().length < TOC_BODY_MAX;
    return short && matches.slice(i + 1).some((o) => headingKey(o) === headingKey(m));
  };
  let toc = 0;
  while (toc < matches.length && isTocEntry(toc)) toc += 1;
  const introEnd = toc < matches.length ? matches[toc].index : normalized.length;
  // dòng ngắn không dấu câu (tên sách, tác giả, mục lục) thêm dấu chấm để TTS ngắt nghỉ
  const intro = normalized.slice(0, introEnd).split('\n')
    .map((line) => line.replace(/[\s.…·_]{2,}\d+\s*$/, '').trim()).filter(Boolean)
    .map((line) => (line.length < 60 && !/[.!?…:;,]$/.test(line) ? `${line}.` : line)).join('\n');
  matches = matches.slice(toc);
  const parts = [];
  if (intro) parts.push({ title: 'Giới thiệu', text: intro });
  matches.forEach((m, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].index : normalized.length;
    const body = normalized.slice(m.index + m[0].length, end).trim();
    parts.push({ title: m[1].trim().slice(0, 500), text: body });
  });
  return parts.filter((p) => p.text).map((p, i) => ({ index: i + 1, ...p }));
}

module.exports = { splitChapters };
