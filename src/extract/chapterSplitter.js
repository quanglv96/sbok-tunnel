'use strict';

const HEADING = /^[ \t]*((?:Chương|CHƯƠNG|Chapter|CHAPTER)\s+\d+[^\n]*)$/gm;

/**
 * BR-8: tách chương theo dòng bắt đầu bằng "Chương N" / "Chapter N". Không có tiêu đề nào -> 1 chương "Toàn bộ".
 * Phần trước chương đầu (nếu có chữ) thành chương "Mở đầu".
 */
function splitChapters(text) {
  const normalized = (text || '').replace(/\r\n?/g, '\n');
  const matches = [...normalized.matchAll(HEADING)];
  if (matches.length === 0) {
    const body = normalized.trim();
    return body ? [{ index: 1, title: 'Toàn bộ', text: body }] : [];
  }
  const parts = [];
  const preface = normalized.slice(0, matches[0].index).trim();
  if (preface) parts.push({ title: 'Mở đầu', text: preface });
  matches.forEach((m, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].index : normalized.length;
    const body = normalized.slice(m.index + m[0].length, end).trim();
    parts.push({ title: m[1].trim().slice(0, 500), text: body });
  });
  return parts.filter((p) => p.text).map((p, i) => ({ index: i + 1, ...p }));
}

module.exports = { splitChapters };
