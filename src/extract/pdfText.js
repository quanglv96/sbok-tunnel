'use strict';

const fs = require('fs');

/** FR-WK-03: trích text từng trang bằng pdfjs-dist (chỉ đọc, không chạy script PDF). */
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
      let line = '';
      const lines = [];
      for (const item of content.items) {
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
      pages.push(lines.join('\n'));
    }
    const info = (meta && meta.info) || {};
    return { text: pages.join('\n'), title: info.Title || null, author: info.Author || null };
  } finally {
    await doc.destroy();
  }
}

module.exports = { extractText };
