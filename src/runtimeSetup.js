'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');

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
};

const PYPI_INDEX = 'https://pypi.org/simple';
const REQUIREMENTS = path.join(__dirname, '..', 'python', 'requirements-runtime.txt');
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
async function download(item, dest, get = httpsGet) {
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
    try {
      await pipeline(res, async function* (src) {
        for await (const chunk of src) {
          hash.update(chunk);
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
 * Trả { pythonPath, ffmpegPath, errors } (path null = chưa dùng được).
 */
async function ensureRuntime({ dataDir, log = console.log, deps = {} }) {
  const run = deps.run || exec;
  const dl = deps.download || download;
  const reqFile = deps.requirementsFile || REQUIREMENTS;
  const rt = path.join(dataDir, 'runtime');
  const env = runtimeEnv(dataDir);
  const ok = async (cmd, args) => (await run(cmd, args, { env })).ok;
  const errors = [];

  const pyDir = path.join(rt, 'python');
  const runtimePy = path.join(pyDir, 'python.exe');
  let pythonPath = await firstWorking([runtimePy], (p) => ok(p, ['-c', TTS_IMPORT]));
  if (!pythonPath) {
    try {
      if (readRequirements(reqFile).length === 0) throw new Error('chưa có danh sách gói pip ghim trong app');
      if (!(await ok(runtimePy, ['--version']))) {
        log('[setup] Đang cài Python vào ' + pyDir);
        const zip = await dl(MANIFEST.python, path.join(rt, 'downloads', 'python.zip'));
        fs.mkdirSync(pyDir, { recursive: true });
        await must(run('tar', ['-xf', zip, '-C', pyDir], { env, timeout: 0 }), 'Giải nén Python');
        enableSite(pyDir);
      }
      if (!(await ok(runtimePy, ['-m', 'pip', '--version']))) {
        log('[setup] Đang cài pip');
        const getPip = await dl(MANIFEST.getPip, path.join(rt, 'downloads', 'get-pip.py'));
        await must(run(runtimePy, [getPip, '--isolated', '--no-input', '--no-cache-dir', '--index-url', PYPI_INDEX,
          '--no-setuptools', '--no-wheel', `pip==${PIP_VERSION}`], { env, timeout: 0 }), 'Cài pip');
      }
      log('[setup] Đang cài VieNeu-TTS và thư viện (có thể mất nhiều phút)');
      await must(run(runtimePy, pipInstallArgs(reqFile), { env, timeout: 0 }), 'Cài gói pip');
      if (!(await ok(runtimePy, ['-c', TTS_IMPORT]))) throw new Error('đã cài nhưng không import được VieNeu-TTS');
      pythonPath = runtimePy;
    } catch (err) {
      errors.push(`Python/VieNeu-TTS: ${err.message}`);
    }
  }

  const ffDir = path.join(rt, 'ffmpeg');
  const runtimeFf = path.join(ffDir, 'bin', 'ffmpeg.exe');
  let ffmpegPath = await firstWorking([runtimeFf], (p) => ok(p, ['-version']));
  if (!ffmpegPath) {
    try {
      log('[setup] Đang cài ffmpeg vào ' + ffDir);
      const zip = await dl(MANIFEST.ffmpeg, path.join(rt, 'downloads', 'ffmpeg.zip'));
      fs.mkdirSync(ffDir, { recursive: true });
      await must(run('tar', ['-xf', zip, '-C', ffDir, '--strip-components=1'], { env, timeout: 0 }), 'Giải nén ffmpeg');
      if (!(await ok(runtimeFf, ['-version']))) throw new Error('đã giải nén nhưng ffmpeg không chạy');
      ffmpegPath = runtimeFf;
    } catch (err) {
      errors.push(`ffmpeg: ${err.message}`);
    }
  }

  return { pythonPath, ffmpegPath, errors };
}

module.exports = {
  ALLOWED_HOSTS, MANIFEST, PYPI_INDEX, REQUIREMENTS, TTS_IMPORT,
  download, ensureRuntime, firstWorking, pipInstallArgs, readRequirements, runtimeEnv,
};
