'use strict';

const { NUM_CTX, chat } = require('../ollama');

// Phần đầu mỗi trang gửi cho LLM: tổng ~30k ký tự cho vừa ngữ cảnh model 3b; sách dài thì mỗi trang ít ký tự hơn
const MAX_PROMPT_CHARS = 30_000;
const PAGE_HEAD_MAX = 300;
const PAGE_HEAD_MIN = 40;
const TITLE_MAX = 500;

/** Lỗi tách chương bằng LLM (Ollama lỗi/timeout/thiếu bộ nhớ, kết quả vi phạm BR-5): được thử lại (BR-6). */
class LlmSplitError extends Error {}

const SYSTEM_PROMPT = [
  'Bạn chia một cuốn sách thành các chương. Đầu vào là phần đầu của từng trang, mỗi trang mở đầu bằng [Trang N].',
  'Dựa vào mục lục (nếu có) và tiêu đề ở đầu trang, liệt kê các chương theo thứ tự.',
  'start_page là số N của trang (theo [Trang N]) nơi chương bắt đầu, không phải số trang in trong mục lục.',
  'Phần trước chương đầu tiên (bìa, lời nói đầu, mục lục) là chương "Giới thiệu" bắt đầu ở trang 1.',
  'Chỉ liệt kê các trang có dòng tiêu đề; trang không liệt kê là thân bài.',
  'Chỉ trả JSON dạng {"chapters":[{"title":"...","start_page":1}]}.',
].join(' ');

// BR-5 (PMO chốt #40): sách dài hơn ngưỡng này mà LLM trả đúng 1 chương = kết quả sai
const MIN_PAGES_MULTI_CHAPTER = 30;
const TOC_TITLE = /^(mục lục|contents|table of contents)$/i;

/** Cách cũ: phần đầu mỗi trang (dùng khi không trang nào có dòng tiêu đề). */
function legacyPrompt(pages) {
  const budget = Math.max(PAGE_HEAD_MIN, Math.min(PAGE_HEAD_MAX, Math.floor(MAX_PROMPT_CHARS / Math.max(pages.length, 1))));
  return pages.map((p, i) => `[Trang ${i + 1}] ${String(p || '').replace(/\s+/g, ' ').trim().slice(0, budget)}`).join('\n');
}

/** BR-5: JSON đọc được, ≥1 chương, start_page nguyên trong [1, pageCount] và tăng dần, tiêu đề không rỗng. */
function parseChapters(content, pageCount) {
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    throw new LlmSplitError('LLM trả kết quả không phải JSON');
  }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.chapters) ? data.chapters : null;
  if (!list) throw new LlmSplitError('LLM trả JSON không có danh sách chương');
  if (list.length === 0) throw new LlmSplitError('LLM trả danh sách chương rỗng');
  let prev = 0;
  const result = list.map((c, i) => {
    const title = c && typeof c.title === 'string' ? c.title.trim() : '';
    const raw = c && c.start_page;
    const page = typeof raw === 'number' || (typeof raw === 'string' && raw.trim()) ? Number(raw) : NaN;
    if (!title) throw new LlmSplitError(`Chương ${i + 1}: tiêu đề rỗng`);
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      throw new LlmSplitError(`Chương ${i + 1}: start_page ${raw} ngoài [1, ${pageCount}]`);
    }
    if (page <= prev) throw new LlmSplitError(`Chương ${i + 1}: start_page ${page} không tăng dần`);
    prev = page;
    return { title: title.slice(0, TITLE_MAX), startPage: page };
  });
  if (pageCount > MIN_PAGES_MULTI_CHAPTER && result.length === 1) {
    throw new LlmSplitError(`LLM trả 1 chương cho sách ${pageCount} trang`);
  }
  return result;
}

/** Cắt text theo trang; trang trước chương đầu gộp thành "Giới thiệu". Cùng dạng `splitChapters`: [{index,title,text}]. */
function cutByPages(pages, chapters) {
  const parts = chapters[0].startPage > 1 ? [{ title: 'Giới thiệu', startPage: 1 }, ...chapters] : chapters;
  return parts
    .map((c, i) => {
      const end = i + 1 < parts.length ? parts[i + 1].startPage - 1 : pages.length;
      return { title: c.title, text: pages.slice(c.startPage - 1, end).join('\n').trim() };
    })
    .filter((p) => p.text)
    .map((p, i) => ({ index: i + 1, ...p }));
}

const HEADING_KEYWORD = /^(chương|phần|phụ lục|chapter|part|appendix)(\s|$|[:.\-–])/iu;
const HEADING_LINE_MAX = 120;
const isUpper = (s) => /\p{L}/u.test(s) && s === s.toUpperCase();
const openParens = (s) => (s.match(/\(/g) || []).length > (s.match(/\)/g) || []).length;
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi');

/**
 * Dòng tiêu đề của trang (CHƯƠNG/PHẦN/PHỤ LỤC… hoặc dòng viết hoa), đã ghép các dòng bị xuống dòng do khổ giấy:
 * dòng sau nối vào khi tiêu đề còn mở ngoặc, kết thúc bằng ":"/"-", hoặc cả hai dòng đều viết hoa.
 */
function headingLines(pageText) {
  const lines = String(pageText || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let cur = lines[i];
    if (!cur || cur.length > HEADING_LINE_MAX || !(HEADING_KEYWORD.test(cur) || isUpper(cur))) continue;
    while (i + 1 < lines.length) {
      const nx = lines[i + 1];
      if (!nx || nx.length > HEADING_LINE_MAX || cur.length + nx.length >= TITLE_MAX || HEADING_KEYWORD.test(nx)) break;
      if (!(openParens(cur) || /[:\-–]$/.test(cur) || (isUpper(cur) && isUpper(nx)))) break;
      cur = `${cur} ${nx}`;
      i++;
    }
    out.push(cur);
  }
  return out;
}

/** LLM thường chỉ lấy dòng đầu của tiêu đề bị xuống dòng: thay bằng tiêu đề đầy đủ trên trang bắt đầu nếu khớp phần đầu. */
function fullTitle(title, pageText) {
  const t = norm(title);
  const hit = headingLines(pageText).find((h) => {
    const n = norm(h);
    return n.length > t.length && n.startsWith(t) && !/[\p{L}\d]/u.test(n[t.length]);
  });
  return hit ? hit.slice(0, TITLE_MAX) : title;
}

/**
 * BR-17: theo thứ tự trang, `[Trang N] ` + dòng tiêu đề (nối " | "); trang mục lục gửi nguyên các dòng;
 * trang không có tiêu đề bỏ qua; dừng khi vượt MAX_PROMPT_CHARS (không cắt giữa khối). Không khối nào → cách cũ.
 */
function promptOf(pages) {
  const blocks = [];
  let total = 0;
  for (let i = 0; i < pages.length; i++) {
    const text = String(pages[i] || '');
    const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    let block;
    if (lines.some((l) => TOC_TITLE.test(norm(l)))) {
      block = `[Trang ${i + 1}]\n${lines.join('\n')}`;
    } else {
      const hs = headingLines(text);
      if (hs.length === 0) continue;
      block = `[Trang ${i + 1}] ${hs.join(' | ')}`;
    }
    const add = block.length + (blocks.length ? 1 : 0);
    if (total + add > MAX_PROMPT_CHARS) break;
    blocks.push(block);
    total += add;
  }
  return blocks.length ? { prompt: blocks.join('\n'), headingPages: blocks.length } : { prompt: legacyPrompt(pages), headingPages: 0 };
}

function buildPrompt(pages) {
  return promptOf(pages).prompt;
}

/**
 * Tách chương bằng LLM. Mọi lỗi (gọi Ollama, kết quả sai) ném `LlmSplitError` (message kèm mã lỗi gốc nếu có).
 * Trả { chapters, stats } (stats để log, không chứa text trang/prompt).
 */
async function splitWithLlm(pages, { model, chatFn = chat, timeoutMs } = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw new LlmSplitError('Không có text trang để tách');
  const { prompt, headingPages } = promptOf(pages);
  let res;
  try {
    res = await chatFn(model, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ], timeoutMs ? { timeoutMs } : {});
  } catch (err) {
    const msg = String((err && err.message) || err);
    const code = err && (err.code || (err.cause && err.cause.code));
    throw new LlmSplitError(`Gọi Ollama lỗi: ${msg}${code && !msg.includes(code) ? ` (${code})` : ''}`);
  }
  const parsed = parseChapters(res && res.content, pages.length)
    .map((c) => ({ ...c, title: fullTitle(c.title, pages[c.startPage - 1]) }));
  const chapters = cutByPages(pages, parsed);
  return { chapters, stats: { ...(res && res.stats), pages: pages.length, headingPages, promptChars: prompt.length, numCtx: NUM_CTX } };
}

module.exports = { LlmSplitError, buildPrompt, cutByPages, fullTitle, headingLines, parseChapters, splitWithLlm };
