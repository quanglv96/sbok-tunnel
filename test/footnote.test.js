'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spokenText } = require('../src/pipeline');

/** PMO #83: bỏ dấu chú thích kiểu "[12]" khỏi nội dung đọc (mọi chế độ tách). */

test('TC-70a: bỏ chú thích dính chữ, giữ dấu câu', () => {
  const out = spokenText('Sách A', { title: 'Chương 1', text: 'sản xuất bột giấy[12]. Nhà máy [3] chạy[4, 5] tốt[6-8]' });
  assert.strictEqual(out, 'Sách A. Chương 1.\nsản xuất bột giấy. Nhà máy chạy tốt');
});

test('TC-70b: chương Giới thiệu cũng bỏ chú thích', () => {
  assert.strictEqual(spokenText('Sách A', { title: 'Giới thiệu', text: 'Lời mở[1] đầu' }), 'Lời mở đầu');
});

test('TC-70d: khoảng [5–7], danh sách [1, 2, 3], đầu dòng giữ \\n, tiêu đề có [1] giữ ở đầu đề', () => {
  assert.strictEqual(spokenText('Sách A', { title: 'Giới thiệu', text: 'Một[5–7] hai [1, 2, 3] ba' }), 'Một hai ba');
  assert.strictEqual(spokenText('Sách A', { title: 'Giới thiệu', text: 'Dòng một\n[9] dòng hai\n\t[10]dòng ba' }),
    'Dòng một\n dòng hai\ndòng ba');
  assert.strictEqual(spokenText('Sách A', { title: 'Chương [1] mở đầu', text: 'Nội dung[2].' }),
    'Sách A. Chương [1] mở đầu.\nNội dung.');
});

test('TC-70c: không đụng ngoặc vuông không phải chú thích', () => {
  const text = 'Năm [2001], mục [a], [ghi chú] và mảng [].';
  assert.strictEqual(spokenText('Sách A', { title: 'Giới thiệu', text }), text);
});
