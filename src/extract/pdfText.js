'use strict';

const fs = require('fs');

// #153: chữ nhỏ hơn 85% cỡ chữ thân bài là chú thích (chân trang, chú thích ảnh, nhãn trong hình) -> bỏ.
const SMALL_RATIO = 0.85;
// #153: dòng chú thích ảnh/bảng có đánh số ("Hình 1.2: ...", "Figure 3 - ...") hoặc ghi nguồn ảnh ("Ảnh: ...").
const CAPTION = new RegExp(
  '^\\s*(?:(?:hình|ảnh|bảng|biểu đồ|sơ đồ|minh hoạ|minh họa|figure|fig\\.?|table|chart)\\s*\\d+(?:[.\\-]\\d+)*\\s*[:.\\-–—)]'
    + '|(?:ảnh|nguồn ảnh|photo|source)\\s*:)',
  'iu',
);
// Số/ký hiệu chú thích nhỏ nằm trong dòng thân bài (chỉ số trên: "...câu¹", "...câu*").
const MARKER = /^[\d*†‡,]+$/;

/** Cỡ chữ thân bài: cỡ có nhiều ký tự nhất (làm tròn 0,5). */
function bodySize(pages) {
  const weight = new Map();
  for (const lines of pages) {
    for (const items of lines) {
      for (const it of items) {
        const n = it.str.trim().length;
        if (!it.h || !n) continue;
        const k = Math.round(it.h * 2) / 2;
        weight.set(k, (weight.get(k) || 0) + n);
      }
    }
  }
  let best = 0;
  let max = -1;
  for (const [k, w] of weight) {
    if (w > max) {
      max = w;
      best = k;
    }
  }
  return best;
}

/** #153: pages = [[[{ str, h }]]] (trang → dòng → mảnh chữ); trả text từng trang đã bỏ chú thích. */
function filterBodyText(pages) {
  const body = bodySize(pages);
  const small = (it) => body > 0 && it.h > 0 && it.h < body * SMALL_RATIO;
  return pages.map((lines) => lines
    .filter((items) => {
      const sizes = items.filter((it) => it.str.trim() && it.h > 0).map((it) => it.h);
      return !(sizes.length && small({ h: Math.max(...sizes) }));
    })
    .map((items) => items.filter((it) => !(small(it) && MARKER.test(it.str.trim()))).map((it) => it.str).join(''))
    .filter((line) => !CAPTION.test(line))
    .join('\n'));
}

/** FR-WK-03: trích text từng trang bằng pdfjs-dist (chỉ đọc, không chạy script PDF). Ảnh không được đọc. */
async function extractText(pdfPath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true }).promise;
  try {
    const meta = await doc.getMetadata().catch(() => null);
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = [];
      const lines = [];
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const t = item.transform || [];
        line.push({ str: item.str, h: item.height || Math.hypot(t[2] || 0, t[3] || 0) });
        if (item.hasEOL) {
          lines.push(line);
          line = [];
        }
      }
      if (line.length) lines.push(line);
      pages.push(lines);
    }
    const info = (meta && meta.info) || {};
    return { text: filterBodyText(pages).join('\n'), title: info.Title || null, author: info.Author || null };
  } finally {
    await doc.destroy();
  }
}

module.exports = { extractText, filterBodyText };
