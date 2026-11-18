'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const ollama = require('./ollama');

/** Lệnh kiểm VieNeu-TTS đã cài (SDK `vieneu`, theo README tác giả). */
const TTS_IMPORT = 'from vieneu import Vieneu; import numpy';

/** BR-15 (#93): chỉ tải từ các host này. Hằng số, không đọc từ env, settings.json hay IPC. */
const ALLOWED_HOSTS = new Set([
  'www.python.org',
  'bootstrap.pypa.io',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

/**
 * File tải trực tiếp, ghim phiên bản qua URL (#115, PMO chọn B). `sha256` tuỳ chọn: có thì bắt buộc khớp,
 * rỗng thì không kiểm hash (vẫn chỉ HTTPS + allowlist). Không được điền hash chưa xác minh.
 */
const PIP_VERSION = '24.3.1';
const MANIFEST = {
  python: { name: 'Python embeddable win64', version: '3.11.9',
    url: 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip', sha256: '' },
  // get-pip.py chỉ là bộ cài; bản pip được ghim bằng tham số `pip==PIP_VERSION`.
  getPip: { name: 'get-pip.py', version: PIP_VERSION, url: 'https://bootstrap.pypa.io/get-pip.py', sha256: '' },
  // Bản build Windows chính thức ffmpeg.org trỏ tới (gyan.dev), release có tag cố định trên GitHub.
  ffmpeg: { name: 'ffmpeg win64', version: '7.1',
    url: 'https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip', sha256: '' },
  // FEAT-007: bản portable Windows chính thức của Ollama (release GitHub có tag cố định)
  ollama: { name: 'Ollama win64', version: '0.9.0',
    url: 'https://github.com/ollama/ollama/releases/download/v0.9.0/ollama-windows-amd64.zip', sha256: '' },
};

const PYPI_INDEX = 'https://pypi.org/simple';
const REQUIREMENTS = path.join(__dirname, '..', 'python', 'requirements-runtime.txt');
const TTS_SCRIPT = path.join(__dirname, '..', 'python', 'tts_runner.py');
const MAX_REDIRECTS = 5;

function exec(cmd, args, { env, timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stderr || stdout || (err && err.message) || '').trim();
      resolve({ ok: !err, out: out.split('\n').slice(-3).join(' ') });
    });
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => https.get(url, resolve).on('error', reject));
}

/** Env cho Python/pip: bỏ PIP_* và PYTHON* để nguồn/index không bị cấu hình ngoài code thay đổi (TC-54). */
function runtimeEnv(dataDir, env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!/^(PIP_|PYTHON)/i.test(k)) out[k] = v;
  }
  out.HF_HOME = path.join(dataDir, 'runtime', 'hf');
  // Windows mặc định cp1252: gói có setup/README UTF-8 làm pip lỗi UnicodeDecodeError (#117). Ép UTF-8 mode.
  out.PYTHONUTF8 = '1';
  out.PYTHONIOENCODING = 'utf-8';
  return out;
}

function assertAllowed(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new Error(`Nguồn tải không được phép: ${u.protocol}//${u.host}`);
  }
  return u;
}

/** Tải 1 mục manifest: chỉ https + host allowlist (kiểm lại ở mỗi redirect); có SHA-256 ghim mà sai thì xoá file. */
async function download(item, dest, get = httpsGet, onProgress = () => {}) {
  if (!item.url) throw new Error(`${item.name}: chưa có nguồn trong app, không cài`);
  let url = item.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = assertAllowed(url);
    const res = await get(u.href);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, u).href;
      continue;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`${item.name}: tải lỗi HTTP ${res.statusCode}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const hash = crypto.createHash('sha256');
    const total = Number(res.headers['content-length']) || 0;
    let received = 0;
    let lastPct = -1;
    onProgress(0, total);
    try {
      await pipeline(res, async function* (src) {
        for await (const chunk of src) {
          hash.update(chunk);
          received += chunk.length;
          // Báo theo từng 1 % (không biết dung lượng thì mỗi 1 MB) để không dội IPC
          const pct = total ? Math.floor((received * 100) / total) : Math.floor(received / 1048576);
          if (pct !== lastPct) {
            lastPct = pct;
            onProgress(received, total);
          }
          yield chunk;
        }
      }, fs.createWriteStream(dest));
    } catch (err) {
      fs.rmSync(dest, { force: true });
      throw err;
    }
    const actual = hash.digest('hex');
    if (item.sha256 && actual !== item.sha256) {
      fs.rmSync(dest, { force: true });
      throw new Error(`${item.name}: SHA-256 không khớp (nhận ${actual}), đã xoá file`);
    }
    return dest;
  }
  throw new Error(`${item.name}: quá ${MAX_REDIRECTS} lần redirect`);
}

/** Các gói pip ghim `==` trong requirements-runtime.txt (bỏ dòng trống/chú thích). */
function readRequirements(file = REQUIREMENTS) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  return lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/** Lệnh pip cố định: chỉ PyPI, gói ghim trong file + gói kéo theo do pip giải (#115), không cache ngoài thư mục data. */
function pipInstallArgs(file = REQUIREMENTS) {
  return ['-m', 'pip', 'install', '--isolated', '--no-input', '--no-cache-dir',
    '--index-url', PYPI_INDEX, '-r', file];
}

/** Ứng viên đầu tiên chạy thật thành công; không có → null (TC-47). */
async function firstWorking(candidates, probe) {
  for (const c of candidates) {
    if (c && (await probe(c))) return c;
  }
  return null;
}

/** Embeddable Python tắt site-packages mặc định: bật `import site` trong python3XX._pth để pip dùng được. */
function enableSite(dir) {
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('._pth'))) {
    const file = path.join(dir, f);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^#\s*import site/m, 'import site'));
  }
}

async function must(promise, what) {
  const r = await promise;
  if (!r.ok) throw new Error(`${what}: ${r.out}`);
}

/**
 * BR-15 (#109): toàn bộ thư viện nằm trong {dataDir}/runtime. Chỉ kiểm bản trong đó (không dùng PATH hay đường dẫn
 * ngoài thư mục data); thiếu/hỏng cái nào thì tự cài cái đó vào đó. Gọi ở mọi lần khởi động.
 * FEAT-007 (BR-4): `split` = { mode, model } đã resolve; mode llm/chưa chọn thì thêm bước Ollama + model.
 * Trả { pythonPath, ffmpegPath, llm?, errors } (path null = chưa dùng được; llm { ok, detail } chỉ có khi kiểm Ollama).
 */
async function ensureRuntime({ dataDir, log = console.log, onProgress = () => {}, deps = {}, split = null }) {
  const run = deps.run || exec;
  const dlRaw = deps.download || download;
  const withLlm = Boolean(split) && split.mode !== 'heuristic';
  // Tiến độ cho UI: bước step/STEPS; received/total byte khi tải file, total = 0 là chưa biết (thanh chạy vô định)
  const STEPS = withLlm ? 7 : 5;
  const progress = (step, label, received = 0, total = 0) => onProgress({ step, steps: STEPS, label, received, total });
  const dl = (step, item, dest, onBytes = () => {}) =>
    dlRaw(item, dest, undefined, (received, total) => {
      progress(step, `Tải ${item.name}`, received, total);
      onBytes(received, total);
    });
  // AC-14: log từng bước kiểm môi trường (cùng mẫu chữ với pipeline#step)
  const step = (name) => {
    const t0 = Date.now();
    log(`[setup] [${name}] bắt đầu`);
    return {
      done: (x) => log(`[setup] [${name}] xong (${Date.now() - t0} ms${x ? `, ${x}` : ''})`),
      // BR-14: fetch lỗi ("fetch failed") để mã gốc ở e.cause.code
      fail: (e) => {
        const msg = String((e && e.message) || e);
        const code = e && (e.code || (e.cause && e.cause.code));
        log(`[setup] [${name}] lỗi (${Date.now() - t0} ms): ${msg}${code && !msg.includes(code) ? ` (${code})` : ''}`);
      },
    };
  };
  const reqFile = deps.requirementsFile || REQUIREMENTS;
  const rt = path.join(dataDir, 'runtime');
  const env = runtimeEnv(dataDir);
  const ok = async (cmd, args) => (await run(cmd, args, { env })).ok;
  const errors = [];

  const pyDir = path.join(rt, 'python');
  const runtimePy = path.join(pyDir, 'python.exe');
  const sPy = step('Python/VieNeu-TTS');
  let pythonPath = await firstWorking([runtimePy], (p) => ok(p, ['-c', TTS_IMPORT]));
  if (!pythonPath) {
    try {
      if (readRequirements(reqFile).length === 0) throw new Error('chưa có danh sách gói pip ghim trong app');
      if (!(await ok(runtimePy, ['--version']))) {
        log('[setup] Đang cài Python vào ' + pyDir);
        const zip = await dl(1, MANIFEST.python, path.join(rt, 'downloads', 'python.zip'));
        progress(1, 'Giải nén Python');
        fs.mkdirSync(pyDir, { recursive: true });
        await must(run('tar', ['-xf', zip, '-C', pyDir], { env, timeout: 0 }), 'Giải nén Python');
        enableSite(pyDir);
      }
      if (!(await ok(runtimePy, ['-m', 'pip', '--version']))) {
        log('[setup] Đang cài pip');
        const getPip = await dl(2, MANIFEST.getPip, path.join(rt, 'downloads', 'get-pip.py'));
        progress(2, 'Cài pip');
        await must(run(runtimePy, [getPip, '--isolated', '--no-input', '--no-cache-dir', '--index-url', PYPI_INDEX,
          '--no-setuptools', '--no-wheel', `pip==${PIP_VERSION}`], { env, timeout: 0 }), 'Cài pip');
      }
      log('[setup] Đang cài VieNeu-TTS và thư viện (có thể mất nhiều phút)');
      progress(3, 'Tải và cài VieNeu-TTS + thư viện pip (có thể mất nhiều phút)');
      await must(run(runtimePy, pipInstallArgs(reqFile), { env, timeout: 0 }), 'Cài gói pip');
      if (!(await ok(runtimePy, ['-c', TTS_IMPORT]))) throw new Error('đã cài nhưng không import được VieNeu-TTS');
      pythonPath = runtimePy;
    } catch (err) {
      sPy.fail(err);
      errors.push(`Python/VieNeu-TTS: ${err.message}`);
    }
  }
  if (pythonPath) sPy.done('sẵn sàng');

  const ffDir = path.join(rt, 'ffmpeg');
  const runtimeFf = path.join(ffDir, 'bin', 'ffmpeg.exe');
  const sFf = step('ffmpeg');
  let ffmpegPath = await firstWorking([runtimeFf], (p) => ok(p, ['-version']));
  if (!ffmpegPath) {
    try {
      log('[setup] Đang cài ffmpeg vào ' + ffDir);
      const zip = await dl(4, MANIFEST.ffmpeg, path.join(rt, 'downloads', 'ffmpeg.zip'));
      progress(4, 'Giải nén ffmpeg');
      fs.mkdirSync(ffDir, { recursive: true });
      await must(run('tar', ['-xf', zip, '-C', ffDir, '--strip-components=1'], { env, timeout: 0 }), 'Giải nén ffmpeg');
      if (!(await ok(runtimeFf, ['-version']))) throw new Error('đã giải nén nhưng ffmpeg không chạy');
      ffmpegPath = runtimeFf;
    } catch (err) {
      sFf.fail(err);
      errors.push(`ffmpeg: ${err.message}`);
    }
  }
  if (ffmpegPath) sFf.done('sẵn sàng');

  // #129: model tải sẵn vào {dataDir}/runtime/hf lúc cài, job không gọi HF Hub. Kiểm offline trước, thiếu mới tải.
  if (pythonPath) {
    const sModel = step('Model VieNeu-TTS');
    try {
      const prefetch = [TTS_SCRIPT, '--prefetch'];
      if (!(await run(pythonPath, prefetch, { env: { ...env, HF_HUB_OFFLINE: '1' }, timeout: 0 })).ok) {
        log('[setup] Đang tải model VieNeu-TTS vào ' + env.HF_HOME);
        progress(5, 'Tải model VieNeu-TTS (chỉ lần đầu, có thể mất nhiều phút)');
        await must(run(pythonPath, prefetch, { env, timeout: 0 }), 'Tải model');
      }
      log('[setup] API/giọng VieNeu-TTS: ' + path.join(path.dirname(env.HF_HOME), 'vieneu-api.txt'));
      sModel.done('sẵn sàng');
    } catch (err) {
      sModel.fail(err);
      errors.push(`Model VieNeu-TTS: ${err.message}`);
    }
  }

  const llm = withLlm ? await ensureOllama({ rt, env, split, log, progress, dl, run, step, ol: deps.ollama || ollama }) : null;
  if (llm && !llm.ok) {
    // Đã chọn llm: chặn nhận job (job nào cũng sẽ lỗi). Chưa chọn: dùng logic hiện tại, chỉ báo ở dòng kiểm tra.
    if (split.mode === 'llm') errors.push(`Ollama/LLM: ${llm.detail}`);
    else log(`[setup] Ollama/LLM chưa dùng được (${llm.detail}): tách chương bằng logic hiện tại`);
  }

  return llm ? { pythonPath, ffmpegPath, llm, errors } : { pythonPath, ffmpegPath, errors };
}

/** FEAT-007 (BR-4): Ollama trong {dataDir}/runtime/ollama, model trong runtime/ollama-models. Đã có thì bỏ qua. */
async function ensureOllama({ rt, env, split, log, progress, dl, run, step, ol }) {
  const dir = path.join(rt, 'ollama');
  const exe = path.join(dir, 'ollama.exe');
  let cur;
  const begin = (name) => (cur = step(name));
  try {
    begin('Ollama: kiểm');
    let st = await ol.isReady(split.model);
    cur.done(`running=${st.running}, hasModel=${st.hasModel}`);
    if (!st.running) {
      if (!fs.existsSync(exe)) {
        log('[setup] Đang cài Ollama vào ' + dir);
        begin('Ollama: tải');
        const zip = await dl(6, MANIFEST.ollama, path.join(rt, 'downloads', 'ollama.zip'), tenPercent(log, 'Ollama: tải'));
        cur.done();
        begin('Ollama: giải nén');
        progress(6, 'Giải nén Ollama');
        fs.mkdirSync(dir, { recursive: true });
        await must(run('tar', ['-xf', zip, '-C', dir], { env, timeout: 0 }), 'Giải nén Ollama');
        cur.done();
      }
      begin('Ollama: serve');
      progress(6, 'Khởi động Ollama');
      ol.serve(exe, { ...env, OLLAMA_HOST: ollama.OLLAMA_HOST, OLLAMA_MODELS: path.join(rt, 'ollama-models') });
      st = await ol.waitReady(split.model);
      if (!st.running) throw new Error('Ollama không khởi động được');
      cur.done();
    }
    if (!st.hasModel) {
      log(`[setup] Đang tải model ${split.model}`);
      const name = `Ollama: pull ${split.model}`;
      begin(name);
      const label = `Tải model ${split.model} (chỉ lần đầu, có thể mất nhiều phút)`;
      progress(7, label);
      const pct = tenPercent(log, name);
      await ol.pull(split.model, { onProgress: (c, t) => { progress(7, label, c, t); pct(c, t); } });
      if (!(await ol.isReady(split.model)).hasModel) throw new Error(`đã tải nhưng chưa thấy model ${split.model}`);
      cur.done();
    }
    return { ok: true, detail: `Ollama + ${split.model}` };
  } catch (err) {
    cur.fail(err);
    return { ok: false, detail: err.message };
  }
}

/** AC-14: log mốc 10% của một lần tải; tổng đổi (layer mới của pull) thì đếm lại. */
function tenPercent(log, name) {
  let last = -1;
  let lastTotal = 0;
  return (received, total) => {
    if (!total) return;
    if (total !== lastTotal) {
      lastTotal = total;
      last = -1;
    }
    const p = Math.min(100, Math.floor((received / total) * 10) * 10);
    if (p > last) {
      last = p;
      log(`[setup] [${name}] ${p}%`);
    }
  };
}

module.exports = {
  ALLOWED_HOSTS, MANIFEST, PYPI_INDEX, REQUIREMENTS, TTS_IMPORT, TTS_SCRIPT,
  download, ensureRuntime, firstWorking, pipInstallArgs, readRequirements, runtimeEnv,
};
