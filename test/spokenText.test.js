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

test('TC-71d: tiêu đề chương viết hoa ở đầu đề cũng đọc thành tên, dòng kết thúc bằng dấu phẩy được ghép', () => {
  const out = spokenText('Từ tốt đến vĩ đại', { title: 'SỰ TÒ MÒ KIÊN TRÌ', text: 'Johnson,\nMerck và Pepsi.' });
  assert.strictEqual(out, 'Từ tốt đến vĩ đại. Sự Tò Mò Kiên Trì.\nJohnson, Merck và Pepsi.');
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
