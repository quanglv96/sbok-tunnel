'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spokenText } = require('../src/pipeline');

/** PMO #92 (job 48a653ab): txt giữ xuống dòng theo khổ giấy PDF → mp3 ngắt quãng; tên tiếng Anh viết hoa bị đánh vần. */

const intro = (text) => spokenText('Sách', { title: 'Giới thiệu', text });

test('TC-71a: dòng bị ngắt giữa câu được ghép thành một đoạn, dòng kết câu giữ xuống dòng', () => {
  const text = 'Chúng ta không có những trường học vĩ đại, chính vì chúng ta đã có trường\n'
    + 'học tốt. Rất ít người sống một cuộc đời vĩ đại, chủ yếu vì người ta chấp nhận Bill\n'
    + 'Meehan nói vậy.\nĐoạn mới.';
  assert.strictEqual(intro(text), 'Chúng ta không có những trường học vĩ đại, chính vì chúng ta đã có trường '
    + 'học tốt. Rất ít người sống một cuộc đời vĩ đại, chủ yếu vì người ta chấp nhận Bill Meehan nói vậy.\nĐoạn mới.');
});

test('TC-71b: đoạn đầu chương thật – tiêu đề xuống dòng, trích dẫn, tác giả và tên sách tiếng Anh thành câu riêng', () => {
  const text = 'CHƯƠNG MỘT: TỐT LÀ KẺ THÙ CỦA\nVĨ ĐẠI\n'
    + 'Điều làm cho cái chết khó khăn là sự tò mò không lời giải đáp\n. – BERYL MARKHAM\n'
    + 'West with the Night\nTốt là kẻ thù của Vĩ Đại.';
  assert.strictEqual(intro(text), 'Chương Một: Tốt Là Kẻ Thù Của Vĩ Đại.\n'
    + 'Điều làm cho cái chết khó khăn là sự tò mò không lời giải đáp. – Beryl Markham.\n'
    + 'West with the Night.\nTốt là kẻ thù của Vĩ Đại.');
});

test('TC-71c: từ viết tắt đứng riêng giữ nguyên, không đổi chữ hoa giữa từ', () => {
  const text = 'Thị trường NASDAQ, GE và 3M; McKINSEY.';
  assert.strictEqual(intro(text), text);
});

test('TC-71d: dòng kết thúc bằng dấu phẩy được ghép, không thêm đầu đề', () => {
  const out = spokenText('Từ tốt đến vĩ đại', { title: 'SỰ TÒ MÒ KIÊN TRÌ', text: 'Johnson,\nMerck và Pepsi.' });
  assert.strictEqual(out, 'Johnson, Merck và Pepsi.');
});

test('TC-72 (PMO #117): chương không mở đầu bằng tên sách + tên chương, tiêu đề chỉ đọc một lần từ nội dung', () => {
  const ch = { title: 'CHƯƠNG MỘT: TỐT LÀ KẺ THÙ CỦA VĨ ĐẠI', text: 'CHƯƠNG MỘT: TỐT LÀ KẺ THÙ CỦA\nVĨ ĐẠI\nTốt là kẻ thù.' };
  const out = spokenText('Từ tốt đến vĩ đại', ch);
  assert.strictEqual(out, 'Chương Một: Tốt Là Kẻ Thù Của Vĩ Đại.\nTốt là kẻ thù.');
  assert.ok(!out.includes('Từ tốt đến vĩ đại'));
  assert.strictEqual(spokenText('Từ tốt đến vĩ đại', { title: 'Toàn bộ', text: 'Nội dung.' }), 'Nội dung.');
  assert.strictEqual(spokenText('S', { title: 'Chương 2 -', text: 'X' }), 'X'); // heuristic
});

test('TC-71e: số La Mã sau một từ giữ nguyên, từ giống La Mã (CIVIL, MID, DIM) vẫn đổi', () => {
  const text = 'PHẦN II: THẾ CHIẾN II.\nCHƯƠNG XIV.\nTHE CIVIL WAR, MID DIM.\nVI PHẠM.';
  assert.strictEqual(intro(text), 'Phần II: Thế Chiến II.\nChương XIV.\nThe Civil War, Mid Dim.\nVi Phạm.');
});

test('TC-71f: biên 49/50 ký tự, dấu kết câu trong ngoặc kép, dòng rỗng, dòng sau bắt đầu bằng dấu phẩy', () => {
  assert.strictEqual(intro(`${'a'.repeat(49)}\nBill`), `${'a'.repeat(49)}.\nBill`);
  assert.strictEqual(intro(`${'a'.repeat(50)}\nBill`), `${'a'.repeat(50)} Bill`);
  assert.strictEqual(intro('Anh nói: “Đi thôi.”\nTiếp theo'), 'Anh nói: “Đi thôi.”\nTiếp theo');
  assert.strictEqual(intro('dòng một\n\nDòng hai'), 'dòng một\n\nDòng hai');
  assert.strictEqual(intro('Johnson\n, Merck và Pepsi.'), 'Johnson, Merck và Pepsi.');
});

test('TC-71j (PMO #99): các dòng PHỤ LỤC viết hoa liền nhau thành câu riêng, "1.A" đọc thành "1A"', () => {
  const text = 'PHỤ LỤC 1.A.: QUÁ TRÌNH TUYỂN CHỌN CÔNG TY NHẢY VỌT\n'
    + 'PHỤ LỤC 1.B: TUYỂN CHỌN CÔNG TY SO SÁNH TRỰC\nTIẾP\nPHỤ LỤC 2';
  assert.strictEqual(intro(text), 'Phụ Lục 1A.: Quá Trình Tuyển Chọn Công Ty Nhảy Vọt.\n'
    + 'Phụ Lục 1B: Tuyển Chọn Công Ty So Sánh Trực Tiếp.\nPhụ Lục 2');
  assert.strictEqual(intro('Xem phụ lục 1.a và tỉ lệ 2.5 lần.'), 'Xem phụ lục 1a và tỉ lệ 2.5 lần.');
  assert.strictEqual(intro('CHƯƠNG MỘT: TỐT LÀ\nVĨ ĐẠI.'), 'Chương Một: Tốt Là Vĩ Đại.');
});

const LONG_PREV = 'Chúng tôi đã nghiên cứu kỹ lưỡng trong nhiều năm và thấy rằng';

test('TC-71k (PMO #107): nội dung chương giữ dấu chấm; chỉ số mục sau Phụ lục/Appendix bỏ chấm', () => {
  for (const s of ['năm 1995.Ở đây.', 'in 1995.A new.', 'mục 1.A.', 'điểm 1.b nhé.', '3.Tiếp.', 'bản v2.0.']) {
    assert.strictEqual(intro(s), s);
  }
  assert.strictEqual(intro('Phụ lục 1.A và 1.B.'), 'Phụ lục 1A và 1.B.');
  assert.strictEqual(intro('Appendix 2.C shows.'), 'Appendix 2C shows.');
  assert.strictEqual(intro('APPENDIX 2.C: DATA SOURCES'), 'APPENDIX 2C: Data Sources');
  assert.strictEqual(intro('TPHỤ LỤC 1.A.'), 'Tphụ Lục 1.A.');
  assert.strictEqual(intro('phụ lục1.A.'), 'phụ lục1.A.');
  assert.ok(LONG_PREV.length >= 50);
  assert.strictEqual(intro(`${LONG_PREV}\nPHẦN LỚN CÁC CÔNG TY TỐT`), `${LONG_PREV} Phần Lớn Các Công Ty Tốt`);
  assert.strictEqual(intro(`${LONG_PREV}\nCHƯƠNG HAI`), `${LONG_PREV} Chương Hai`);
  assert.strictEqual(intro(`${LONG_PREV}\nPHỤ LỤC 3`), `${LONG_PREV}.\nPhụ Lục 3`);
});

test('TC-71l (biên BR-23.1a): dấu ":" trước dòng PHỤ LỤC, Phụ lục không viết hoa, PHỤ LỤCA', () => {
  assert.strictEqual(intro('Danh sách:\nPHỤ LỤC 3'), 'Danh sách:\nPhụ Lục 3');
  assert.strictEqual(intro(`${LONG_PREV}\nPhụ lục 2 cho thấy.`), `${LONG_PREV} Phụ lục 2 cho thấy.`);
  assert.strictEqual(intro(`${LONG_PREV}\nPHỤ LỤCA BÊN`), `${LONG_PREV} Phụ Lụca Bên`);
});
