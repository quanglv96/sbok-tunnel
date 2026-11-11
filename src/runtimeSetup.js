'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');

/** Lệnh kiểm VieNeu-TTS đã cài (tên module chờ C-0a xác nhận theo README của tác giả). */
const TTS_IMPORT = 'import vieneu_tts, soundfile, numpy';

/** BR-15 (#93): chỉ tải từ các host này. Hằng số, không đọc từ env, settings.json hay IPC. */
const ALLOWED_HOSTS = new Set([
  'www.python.org',
  'bootstrap.pypa.io',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

/**
 * File tải trực tiếp, ghim phiên bản + SHA-256 (C-0a). `url` hoặc `sha256` rỗng = chưa ghim → không cài, báo đỏ.
 * Không được điền URL/hash chưa xác minh.
 */
const MANIFEST = {
  python: { name: 'Python embeddable win64', version: '3.11.9',
    url: 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip', sha256: '' },
  getPip: { name: 'get-pip.py', version: '', url: '', sha256: '' },
  ffmpeg: { name: 'ffmpeg win64', version: '', url: '', sha256: '' },
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
  return out;
}

function assertAllowed(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new Error(`Nguồn tải không được phép: ${u.protocol}//${u.host}`);
  }
  return u;
}

/** Tải 1 mục manifest: chỉ https + host allowlist (kiểm lại ở mỗi redirect), sai SHA-256 thì xoá file. */
async function download(item, dest, get = httpsGet) {
  if (!item.url || !/^[0-9a-f]{64}$/.test(item.sha256)) {
    throw new Error(`${item.name}: chưa ghim nguồn/SHA-256 trong app, không cài`);
  }
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
    if (actual !== item.sha256) {
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

/** Lệnh pip cố định: chỉ PyPI, không kéo gói ngoài danh sách (TC-54). */
function pipInstallArgs(file = REQUIREMENTS) {
  return ['-m', 'pip', 'install', '--isolated', '--no-input', '--no-deps', '--index-url', PYPI_INDEX, '-r', file];
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
 * BR-15: kiểm Python + VieNeu-TTS và ffmpeg theo thứ tự settings → {dataDir}/runtime → PATH; thiếu cái nào thì
 * tự cài cái đó vào {dataDir}/runtime. Trả { pythonPath, ffmpegPath, errors } (path null = chưa dùng được).
 */
async function ensureRuntime({ dataDir, settings = {}, log = console.log, deps = {} }) {
  const run = deps.run || exec;
  const dl = deps.download || download;
  const reqFile = deps.requirementsFile || REQUIREMENTS;
  const rt = path.join(dataDir, 'runtime');
  const env = runtimeEnv(dataDir);
  const ok = async (cmd, args) => (await run(cmd, args, { env })).ok;
  const errors = [];

  const pyDir = path.join(rt, 'python');
  const runtimePy = path.join(pyDir, 'python.exe');
  let pythonPath = await firstWorking([settings.pythonPath, runtimePy, 'python'], (p) => ok(p, ['-c', TTS_IMPORT]));
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
        await must(run(runtimePy, [getPip, '--isolated', '--no-input', '--index-url', PYPI_INDEX,
          '--no-setuptools', '--no-wheel'], { env, timeout: 0 }), 'Cài pip');
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
  let ffmpegPath = await firstWorking([settings.ffmpegPath, runtimeFf, 'ffmpeg'], (p) => ok(p, ['-version']));
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
