'use strict';

const fs = require('fs');
const path = require('path');

/** BR-15: đọc {userData}/settings.json. Không có hoặc hỏng → {} (coi như chưa cài, không crash). */
function readSettings(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

/** Ghi file tạm rồi rename để không để lại settings.json dở dang. */
function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { readSettings, writeSettings };
