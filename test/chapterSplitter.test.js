'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { splitChapters } = require('../src/extract/chapterSplitter');

test('TC-24: "Chương 1", "Chương 2" -> 2 chương', () => {
  const chapters = splitChapters('Chương 1: Khởi đầu\nNội dung một.\nChương 2\nNội dung hai.');
  assert.deepStrictEqual(chapters.map((c) => [c.index, c.title, c.text]), [
    [1, 'Chương 1: Khởi đầu', 'Nội dung một.'],
    [2, 'Chương 2', 'Nội dung hai.'],
  ]);
});

test('TC-25: không có tiêu đề chương -> 1 chương "Toàn bộ"', () => {
  assert.deepStrictEqual(splitChapters('Một câu chuyện ngắn.'), [{ index: 1, title: 'Toàn bộ', text: 'Một câu chuyện ngắn.' }]);
});

test('TC-26: PDF không có chữ -> không có chương (pipeline báo FAILED)', () => {
  assert.deepStrictEqual(splitChapters('  \n '), []);
});

test('phần trước chương đầu thành "Mở đầu"; chữ "chương 3" giữa câu không tách', () => {
  const chapters = splitChapters('Lời tựa.\nChapter 1\nText, xem chương 3 sau.');
  assert.deepStrictEqual(chapters.map((c) => c.title), ['Mở đầu', 'Chapter 1']);
});
