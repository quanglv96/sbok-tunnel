'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { filterBodyText } = require('../src/extract/pdfText');

const line = (...items) => items.map(([str, h]) => ({ str, h }));

test('TC-60: bỏ dòng cỡ < 85%, số chú thích nhỏ, dòng "Hình 1:"/"Nguồn ảnh:"; giữ tiêu đề to và câu "Hình ảnh đẹp" (#153)', () => {
  const pages = [[
    line(['CHƯƠNG MỘT', 20]),
    line(['Thân bài có chú thích', 10], ['1', 6], [' ở giữa câu.', 10]),
    line(['Hình ảnh đẹp của buổi sáng.', 10]),
    line(['Hình 1: Biểu đồ doanh thu', 10]),
    line(['Nguồn ảnh: Internet', 10]),
    line(['1. Chú thích chân trang in nhỏ', 7]),
  ]];
  assert.deepStrictEqual(filterBodyText(pages), [
    'CHƯƠNG MỘT\nThân bài có chú thích ở giữa câu.\nHình ảnh đẹp của buổi sáng.',
  ]);
});

test('TC-60 biên: đúng 85% cỡ thân bài vẫn giữ', () => {
  const pages = [[line(['Thân bài dài hơn nhiều chữ.', 10]), line(['Trích dẫn', 8.5])]];
  assert.deepStrictEqual(filterBodyText(pages), ['Thân bài dài hơn nhiều chữ.\nTrích dẫn']);
});

test('TC-61: PDF không có cỡ chữ -> giữ nguyên văn bản (trừ dòng chú thích ảnh)', () => {
  const pages = [[line(['Dòng một', 0]), line(['2', 0]), line(['Dòng ba', undefined])]];
  assert.deepStrictEqual(filterBodyText(pages), ['Dòng một\n2\nDòng ba']);
});
