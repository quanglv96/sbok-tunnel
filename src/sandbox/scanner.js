'use strict';

const zlib = require('zlib');

/** BR-4: khoá PDF bị cấm (SRS + đề xuất SA). */
const FORBIDDEN_KEYS = [
  'JavaScript', 'JS', 'Launch', 'EmbeddedFiles', 'SubmitForm', 'OpenAction', 'AA', 'RichMedia', 'XFA',
];
const FORBIDDEN = new Set(FORBIDDEN_KEYS);

const MAX_STREAM_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_INFLATED = 200 * 1024 * 1024;

/** Tên PDF có thể viết dạng #xx (vd /J#61vaScript): giải mã trước khi so. */
function decodeName(name) {
  return name.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Chỉ token tên PDF (bắt đầu bằng "/", kết thúc ở ký tự phân cách) mới tính: chữ "JavaScript" trong văn bản thường
 * không vi phạm (TC-20). Không bỏ qua chuỗi literal: thà chặn nhầm hiếm hoi còn hơn để lọt khoá giấu sau "(" lẻ.
 */
function findForbiddenKey(text) {
  const names = text.matchAll(/\/([^\s/<>\[\]()\{\}%]+)/g);
  for (const m of names) {
    const name = decodeName(m[1]);
    if (FORBIDDEN.has(name)) return '/' + name;
  }
  return null;
}

/** Giải nén các stream FlateDecode (object stream có thể giấu khoá); giới hạn dung lượng chống zip bomb. */
function inflatedStreams(buffer) {
  const result = [];
  let total = 0;
  let pos = 0;
  while (total < MAX_TOTAL_INFLATED) {
    const start = buffer.indexOf('stream', pos, 'latin1');
    if (start < 0) break;
    let dataStart = start + 6;
    if (buffer[dataStart] === 0x0d) dataStart++;
    if (buffer[dataStart] === 0x0a) dataStart++;
    const end = buffer.indexOf('endstream', dataStart, 'latin1');
    if (end < 0) break;
    pos = end + 9;
    try {
      const out = zlib.inflateSync(buffer.subarray(dataStart, end), { maxOutputLength: MAX_STREAM_BYTES });
      total += out.length;
      result.push(out.toString('latin1'));
    } catch {
      // không phải Flate hoặc hỏng: bỏ qua, phần thô đã được quét
    }
  }
  return result;
}

/** Trả khoá vi phạm đầu tiên (vd "/JavaScript") hoặc null nếu sạch. */
function scanPdf(buffer) {
  const raw = findForbiddenKey(buffer.toString('latin1'));
  if (raw) return raw;
  for (const text of inflatedStreams(buffer)) {
    const key = findForbiddenKey(text);
    if (key) return key;
  }
  return null;
}

module.exports = { scanPdf, FORBIDDEN_KEYS };
