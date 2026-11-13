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

test('#139: số chương bằng chữ/La Mã, chữ NFD, mục lục; câu văn "Chương hai trình bày" không phải tiêu đề', () => {
  const text = [
    'MỤC LỤC',
    'CHƯƠNG MỘT: TỐT LÀ KẺ THÙ CỦA VĨ ĐẠI ..... 9',
    'CHƯƠNG HAI: KHẢ NĂNG LÃNH ĐẠO ..... 30',
    'CHƯƠNG MỘT: TỐT LÀ KẺ THÙ CỦA VĨ ĐẠI'.normalize('NFD'),
    'Nội dung một dài.',
    'Chương hai trình bày về lãnh đạo.',
    'CHƯƠNG HAI: KHẢ NĂNG LÃNH ĐẠO',
    'Nội dung hai.',
    'Chương Mười Một',
    'Nội dung mười một.',
    'CHƯƠNG IV.',
    'Nội dung bốn.',
  ].join('\n');
  assert.deepStrictEqual(splitChapters(text).map((c) => [c.index, c.title]), [
    [1, 'Giới thiệu'],
    [2, 'CHƯƠNG MỘT: TỐT LÀ KẺ THÙ CỦA VĨ ĐẠI'],
    [3, 'CHƯƠNG HAI: KHẢ NĂNG LÃNH ĐẠO'],
    [4, 'Chương Mười Một'],
    [5, 'CHƯƠNG IV.'],
  ]);
  assert.match(splitChapters(text)[1].text, /Chương hai trình bày/);
});

test('TC-25: không có tiêu đề chương -> 1 chương "Toàn bộ"', () => {
  assert.deepStrictEqual(splitChapters('Một câu chuyện ngắn.'), [{ index: 1, title: 'Toàn bộ', text: 'Một câu chuyện ngắn.' }]);
});

test('TC-26: PDF không có chữ -> không có chương (pipeline báo FAILED)', () => {
  assert.deepStrictEqual(splitChapters('  \n '), []);
});

test('phần trước chương đầu thành "Giới thiệu"; chữ "chương 3" giữa câu không tách', () => {
  const chapters = splitChapters('Lời tựa.\nChapter 1\nText, xem chương 3 sau.');
  assert.deepStrictEqual(chapters.map((c) => c.title), ['Giới thiệu', 'Chapter 1']);
});

test('#135: bìa + mục lục gộp 1 chương "Giới thiệu", bỏ số trang; chương thật giữ nguyên', () => {
  const long = 'Nội dung dài. '.repeat(20);
  const chapters = splitChapters(`Nhà Giả Kim\nPaulo Coelho\nMục lục\nChương 1: Khởi đầu ..... 5\nChương 2 ..... 12\n`
    + `Chương 1: Khởi đầu\n${long}\nChương 2\n${long}`);
  assert.deepStrictEqual(chapters.map((c) => c.title), ['Giới thiệu', 'Chương 1: Khởi đầu', 'Chương 2']);
  assert.strictEqual(chapters[0].text, 'Nhà Giả Kim.\nPaulo Coelho.\nMục lục.\nChương 1: Khởi đầu.\nChương 2.');
});

test('#147: mục lục xuống dòng, chương không lặp lại, dòng cuối mục lục thân dài -> gộp hết vào "Giới thiệu"', () => {
  const long = 'Nội dung dài. '.repeat(20);
  const chapters = splitChapters([
    'MỤC LỤC',
    'CHƯƠNG MỘT: TỐT LÀ KẺ THÙ CỦA VĨ ĐẠI',
    'CHƯƠNG BA: ĐỐI DIỆN SỰ THẬT (NHƯNG KHÔNG',
    'MẤT NIỀM TIN)',
    'CHƯƠNG BỐN: KHÁI NIỆM CON NHÍM',
    'CHƯƠNG CHÍN: TỪ XÂY DỰNG ĐỂ TRƯỜNG',
    'TỒN',
    `GIỚI THIỆU\n${long}`,
    'CHƯƠNG MỘT: TỐT LÀ KẺ THÙ CỦA',
    'VĨ ĐẠI',
    long,
  ].join('\n'));
  assert.deepStrictEqual(chapters.map((c) => c.title), ['Giới thiệu', 'CHƯƠNG MỘT: TỐT LÀ KẺ THÙ CỦA VĨ ĐẠI']);
  assert.match(chapters[0].text, /MẤT NIỀM TIN\)/);
  assert.strictEqual(chapters[1].text, long.trim());
});

test('#135: sách nhiều phần lặp số chương (thân dài) không bị coi là mục lục', () => {
  const long = 'Nội dung dài. '.repeat(20);
  const chapters = splitChapters(`Chương 1\n${long}\nChương 1\n${long}`);
  assert.deepStrictEqual(chapters.map((c) => c.title), ['Chương 1', 'Chương 1']);
});
