'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { scanPdf, FORBIDDEN_KEYS } = require('../src/sandbox/scanner');
const { runScan } = require('../src/sandbox/scanWorker');

const pdf = (body) => Buffer.from(`%PDF-1.7\n1 0 obj\n<< ${body} >>\nendobj\n%%EOF`, 'latin1');

test('TC-19: mỗi khoá BR-4 đều bị phát hiện', () => {
  for (const key of FORBIDDEN_KEYS) {
    assert.strictEqual(scanPdf(pdf(`/Type /Catalog /${key} 2 0 R`)), `/${key}`);
  }
});

test('TC-20: chữ JavaScript trong văn bản thường, tên dài hơn khoá, không vi phạm', () => {
  assert.strictEqual(scanPdf(pdf('/Type /Page /Title (Hoc JavaScript co ban) /JSON 1 /AAA 2')), null);
});

test('khoá viết dạng #xx hoặc giấu trong object stream nén vẫn bị phát hiện', () => {
  assert.strictEqual(scanPdf(pdf('/J#61vaScript 3 0 R')), '/JavaScript');
  const hidden = zlib.deflateSync(Buffer.from('<< /S /Launch /F (calc.exe) >>', 'latin1'));
  const buf = Buffer.concat([
    Buffer.from('%PDF-1.7\n2 0 obj\n<< /Type /ObjStm /Filter /FlateDecode >>\nstream\n', 'latin1'),
    hidden,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);
  assert.strictEqual(scanPdf(buf), '/Launch');
});

test('runScan chạy trong worker_thread và trả kết quả', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbok-')), 'a.pdf');
  fs.writeFileSync(file, pdf('/OpenAction 5 0 R'));
  assert.strictEqual(await runScan(file), '/OpenAction');
});
