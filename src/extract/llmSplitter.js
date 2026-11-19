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
// Job e83b222e: runner Ollama chết ("exit status 2") ở num_ctx lớn trên máy ít RAM → lùi dần ngữ cảnh
const CTX_STEPS = [NUM_CTX, 8192, 4096];
const RUNNER_CRASH = /llama runner process has terminated|out of memory|unable to allocate|failed to allocate|bad allocation/i;
const TOC_TITLE = /^(mục lục|contents|table of contents)$/i;

/** Cách cũ: phần đầu mỗi trang (dùng khi không trang nào có dòng tiêu đề). */
function legacyPrompt(pages, maxChars = MAX_PROMPT_CHARS) {
  const budget = Math.max(PAGE_HEAD_MIN, Math.min(PAGE_HEAD_MAX, Math.floor(maxChars / Math.max(pages.length, 1))));
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

const isTocPage = (text) => String(text || '').split('\n').some((l) => TOC_TITLE.test(norm(l)));
// a bắt đầu bằng b và ký tự ngay sau không phải chữ/số ("chương 1" không khớp "chương 10")
const startsAt = (a, b) => a.startsWith(b) && !/[\p{L}\d]/u.test(a[b.length] || '');

/** Trang có dòng tiêu đề khớp title (tiêu đề đầy đủ bắt đầu bằng title, hoặc title bắt đầu bằng dòng CHƯƠNG/PHẦN… của trang). */
function titleOnPage(title, pageText) {
  const t = norm(title);
  return headingLines(pageText).some((h) => {
    const n = norm(h);
    return startsAt(n, t) || (HEADING_KEYWORD.test(h) && startsAt(t, n));
  });
}

/**
 * LLM hay gán start_page lệch (chương lấy trang của mục trước, ví dụ CHƯƠNG MỘT nhận trang GIỚI THIỆU) và chép cả
 * " | " của prompt vào title. Bỏ phần sau " | "; chương mà trang LLM chỉ ra không có dòng tiêu đề khớp thì dời về
 * trang đầu tiên sau chương trước có dòng tiêu đề khớp (bỏ trang mục lục); không tìm thấy thì giữ trang LLM.
 * Chương đầu ở trang 1 giữ nguyên; chương không còn tăng dần sau khi dời bị gộp vào chương trước.
 */
function alignToHeadings(chapters, pages) {
  const out = [];
  let prev = 0;
  for (const c of chapters) {
    const title = c.title.split(' | ')[0].trim() || c.title;
    const at = (p) => !isTocPage(pages[p - 1]) && titleOnPage(title, pages[p - 1]);
    let page = c.startPage;
    if (!(page === 1 && out.length === 0) && !at(page)) {
      for (let p = prev + 1; p <= pages.length; p++) {
        if (at(p)) {
          page = p;
          break;
        }
      }
    }
    if (page <= prev) continue;
    out.push({ title, startPage: page });
    prev = page;
  }
  return out;
}

/** BR-19: mục mục lục = dòng không rỗng của trang mục lục, bỏ dòng "Mục lục", bỏ đuôi dấu chấm dẫn/số trang. */
function tocEntries(pages) {
  const out = [];
  for (const text of pages) {
    if (!isTocPage(text)) continue;
    for (const raw of String(text || '').split('\n')) {
      const line = raw.replace(/\s+/g, ' ').trim();
      if (!line || TOC_TITLE.test(norm(line))) continue;
      const entry = line.replace(/[\s.…·]*\d+\s*$/, '').trim();
      if (entry && entry.length <= HEADING_LINE_MAX) out.push(entry);
    }
  }
  return out;
}

/**
 * BR-19: thêm mục mục lục LLM bỏ sót: mục chưa trùng chương nào (khớp hai chiều) và có trang khớp tiêu đề
 * (không tính trang mục lục) chưa là trang bắt đầu của chương nào. Không có mục lục → trả nguyên.
 */
function addTocEntries(chapters, pages) {
  const entries = tocEntries(pages);
  if (entries.length === 0) return { chapters, tocCount: 0, added: 0 };
  const list = [...chapters];
  let added = 0;
  for (const e of entries) {
    const n = norm(e);
    if (list.some((c) => startsAt(norm(c.title), n) || startsAt(n, norm(c.title)))) continue;
    let page = 0;
    for (let p = 1; p <= pages.length; p++) {
      if (!isTocPage(pages[p - 1]) && titleOnPage(e, pages[p - 1])) {
        page = p;
        break;
      }
    }
    if (!page || list.some((c) => c.startPage === page)) continue;
    list.push({ title: e, startPage: page });
    added++;
  }
  list.sort((a, b) => a.startPage - b.startPage);
  return { chapters: list, tocCount: entries.length, added };
}

/**
 * BR-17: theo thứ tự trang, `[Trang N] ` + dòng tiêu đề (nối " | "); trang mục lục gửi nguyên các dòng;
 * trang không có tiêu đề bỏ qua; dừng khi vượt MAX_PROMPT_CHARS (không cắt giữa khối). Không khối nào → cách cũ.
 */
function promptOf(pages, maxChars = MAX_PROMPT_CHARS) {
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
    if (total + add > maxChars) break;
    blocks.push(block);
    total += add;
  }
  return blocks.length
    ? { prompt: blocks.join('\n'), headingPages: blocks.length }
    : { prompt: legacyPrompt(pages, maxChars), headingPages: 0 };
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
  let res;
  let prompt;
  let headingPages;
  let numCtx;
  const tried = [];
  // Runner Ollama chết khi nạp model (thiếu RAM cho KV cache) → thử ngay ngữ cảnh nhỏ hơn, prompt co theo tỉ lệ
  for (numCtx of CTX_STEPS) {
    ({ prompt, headingPages } = promptOf(pages, Math.floor(MAX_PROMPT_CHARS * numCtx / NUM_CTX)));
    tried.push(numCtx);
    try {
      res = await chatFn(model, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ], { numCtx, ...(timeoutMs ? { timeoutMs } : {}) });
      break;
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (RUNNER_CRASH.test(msg) && numCtx !== CTX_STEPS[CTX_STEPS.length - 1]) continue;
      const code = err && (err.code || (err.cause && err.cause.code));
      const ctxNote = tried.length > 1 ? ` [đã thử num_ctx ${tried.join('/')}]` : '';
      throw new LlmSplitError(`Gọi Ollama lỗi: ${msg}${code && !msg.includes(code) ? ` (${code})` : ''}${ctxNote}`);
    }
  }
  const toc = addTocEntries(alignToHeadings(parseChapters(res && res.content, pages.length), pages), pages);
  // BR-5 lần 2 (AC-21): sau căn trang + bổ sung mục lục, đếm trước khi cutByPages tự thêm "Giới thiệu"
  if (pages.length > MIN_PAGES_MULTI_CHAPTER && toc.chapters.length === 1) {
    throw new LlmSplitError(`Sau căn trang chỉ còn 1 chương cho sách ${pages.length} trang`);
  }
  const parsed = toc.chapters.map((c) => ({ ...c, title: fullTitle(c.title, pages[c.startPage - 1]) }));
  const chapters = cutByPages(pages, parsed);
  return {
    chapters,
    stats: {
      ...(res && res.stats), pages: pages.length, headingPages, tocEntries: toc.tocCount, tocAdded: toc.added,
      promptChars: prompt.length, numCtx, ...(tried.length > 1 ? { ctxTried: tried.join('/') } : {}),
    },
  };
}

module.exports = { LlmSplitError, buildPrompt, cutByPages, fullTitle, headingLines, parseChapters, splitWithLlm };
