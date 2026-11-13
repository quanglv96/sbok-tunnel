'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const {
  ALLOWED_HOSTS, MANIFEST, PYPI_INDEX, REQUIREMENTS, TTS_IMPORT,
  download, ensureRuntime, pipInstallArgs, readRequirements, runtimeEnv,
} = require('../src/runtimeSetup');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const reply = (statusCode, body = '', headers = {}) => Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers });
const item = { name: 'test', url: 'https://github.com/x/y.zip', sha256: sha('abc') };

test('TC-48: SHA-256 đúng → ghi file; sai → xoá file, lỗi', async () => {
  const dest = path.join(tmp('sbok-dl-'), 'f.zip');
  await download(item, dest, async () => reply(200, 'abc'));
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'abc');

  const bad = path.join(tmp('sbok-dl-'), 'f.zip');
  await assert.rejects(download(item, bad, async () => reply(200, 'xyz')), /SHA-256 không khớp/);
  assert.ok(!fs.existsSync(bad));
});

test('#119: download báo tiến độ received/total theo content-length; không có content-length → total 0', async () => {
  const seen = [];
  const dest = path.join(tmp('sbok-dl-'), 'f.zip');
  await download(item, dest, async () => reply(200, 'abc', { 'content-length': '3' }), (r, t) => seen.push([r, t]));
  assert.deepStrictEqual(seen[0], [0, 3]);
  assert.deepStrictEqual(seen.at(-1), [3, 3]);

  const noLen = [];
  await download(item, dest, async () => reply(200, 'abc'), (r, t) => noLen.push([r, t]));
  assert.ok(noLen.every(([, t]) => t === 0));
});

test('TC-53: http, host ngoài allowlist, redirect ra ngoài → từ chối trước khi ghi file', async () => {
  const dest = path.join(tmp('sbok-dl-'), 'f.zip');
  const calls = [];
  const get = async (url) => {
    calls.push(url);
    return reply(302, '', { location: 'https://evil.example/f.zip' });
  };
  await assert.rejects(download({ ...item, url: 'http://github.com/x' }, dest, get), /không được phép/);
  await assert.rejects(download({ ...item, url: 'https://evil.example/x' }, dest, get), /không được phép/);
  await assert.rejects(download(item, dest, get), /không được phép/);
  assert.deepStrictEqual(calls, [item.url]);
  assert.ok(!fs.existsSync(dest));

  // Redirect trong allowlist thì theo
  const ok = [];
  await download(item, dest, async (url) => {
    ok.push(url);
    return ok.length === 1 ? reply(302, '', { location: 'https://objects.githubusercontent.com/f' }) : reply(200, 'abc');
  });
  assert.strictEqual(ok[1], 'https://objects.githubusercontent.com/f');
});

test('#115: mục không ghim SHA-256 → vẫn tải (allowlist vẫn áp dụng); không có url → không tải', async () => {
  const dest = path.join(tmp('sbok-dl-'), 'f.zip');
  await download({ ...item, sha256: '' }, dest, async () => reply(200, 'xyz'));
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'xyz');
  await assert.rejects(download({ ...item, sha256: '', url: 'https://evil.example/x' }, dest, async () => reply(200)), /không được phép/);
  let called = false;
  await assert.rejects(download({ ...item, url: '' }, 'x', async () => { called = true; }), /chưa có nguồn/);
  assert.strictEqual(called, false);
});

test('TC-53 (tĩnh): mọi mục manifest có https + host allowlist + phiên bản; sha256 nếu có thì 64 hex', () => {
  for (const m of Object.values(MANIFEST)) {
    assert.strictEqual(new URL(m.url).protocol, 'https:', m.name);
    assert.ok(ALLOWED_HOSTS.has(new URL(m.url).hostname), m.name);
    assert.ok(m.version, m.name);
    if (m.sha256) assert.match(m.sha256, /^[0-9a-f]{64}$/, m.name);
  }
});

test('TC-54: lệnh pip cố định PyPI, -r; env bỏ PIP_*/PYTHON*; file chỉ có dòng tên gói (ghim ==)', () => {
  const args = pipInstallArgs();
  assert.deepStrictEqual(args.slice(args.indexOf('--index-url'), args.indexOf('--index-url') + 2), ['--index-url', PYPI_INDEX]);
  assert.ok(args.includes('--isolated') && args.includes('--no-cache-dir'));
  assert.ok(!args.some((a) => /extra-index|find-links|trusted-host/.test(a)));
  assert.strictEqual(args[args.indexOf('-r') + 1], REQUIREMENTS);

  const env = runtimeEnv('D:\\data', { PIP_INDEX_URL: 'https://evil', PIP_EXTRA_INDEX_URL: 'x', PYTHONPATH: 'x', PATH: 'p' });
  assert.deepStrictEqual(Object.keys(env).sort(), ['HF_HOME', 'PATH', 'PYTHONIOENCODING', 'PYTHONUTF8']);
  assert.strictEqual(env.PYTHONUTF8, '1');
  assert.strictEqual(runtimeEnv('D:\\data', { PYTHONUTF8: '0' }).PYTHONUTF8, '1');
  assert.strictEqual(env.HF_HOME, path.join('D:\\data', 'runtime', 'hf'));

  const lines = readRequirements();
  assert.ok(lines.length > 0);
  for (const line of lines) assert.match(line, /^[A-Za-z0-9._-]+(==[^\s=]+)?$/, line);
});

/** Máy giả: `has` là các lệnh đang chạy được; tar/pip "cài" thì thêm vào `has`. */
function fakeMachine(dataDir, has) {
  const rt = path.join(dataDir, 'runtime');
  const py = path.join(rt, 'python', 'python.exe');
  const ff = path.join(rt, 'ffmpeg', 'bin', 'ffmpeg.exe');
  const downloads = [];
  const run = async (cmd, args, opts = {}) => {
    if (args.includes('--prefetch')) {
      // #129: offline chỉ đạt khi model đã có; online thì "tải" model
      if (opts.env?.HF_HUB_OFFLINE !== '1') {
        downloads.push('model');
        if (!has.has('model-fail')) has.add('model');
      }
      return { ok: has.has('model'), out: 'model' };
    }
    if (cmd === 'tar') {
      has.add(args.includes('--strip-components=1') ? `${ff} -version` : `${py} --version`);
      return { ok: true, out: '' };
    }
    if (args[0] && args[0].endsWith('get-pip.py')) has.add(`${py} -m pip --version`);
    if (args.includes('-r')) has.add(`${py} -c ${TTS_IMPORT}`);
    const key = `${cmd} ${args.join(' ')}`;
    return { ok: has.has(key) || args[0]?.endsWith('get-pip.py') || args.includes('-r'), out: key };
  };
  const dl = async (m, dest) => {
    downloads.push(m.name);
    return dest;
  };
  return { py, ff, run, dl, downloads };
}

test('TC-47/TC-49: lần khởi động sau, runtime trong thư mục data đủ → dùng luôn, không tải gì', async () => {
  const dataDir = tmp('sbok-rt-');
  const has = new Set();
  const m = fakeMachine(dataDir, has);
  has.add(`${m.py} -c ${TTS_IMPORT}`).add(`${m.ff} -version`).add('model');
  const r = await ensureRuntime({ dataDir, log: () => {}, deps: { run: m.run, download: m.dl } });
  assert.deepStrictEqual(r, { pythonPath: m.py, ffmpegPath: m.ff, errors: [] });
  assert.deepStrictEqual(m.downloads, []);
});

test('#129: chưa có model → tải lúc cài; tải lỗi → errors (không nhận job)', async () => {
  const dataDir = tmp('sbok-rt-');
  const has = new Set();
  const m = fakeMachine(dataDir, has);
  has.add(`${m.py} -c ${TTS_IMPORT}`).add(`${m.ff} -version`);
  const r = await ensureRuntime({ dataDir, log: () => {}, deps: { run: m.run, download: m.dl } });
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(m.downloads, ['model']);

  const has2 = new Set(['model-fail']);
  const m2 = fakeMachine(dataDir, has2);
  has2.add(`${m2.py} -c ${TTS_IMPORT}`).add(`${m2.ff} -version`);
  const r2 = await ensureRuntime({ dataDir, log: () => {}, deps: { run: m2.run, download: m2.dl } });
  assert.match(r2.errors[0], /Model VieNeu-TTS/);
});

test('#109: Python/ffmpeg ở PATH chạy được vẫn bị bỏ qua → cài vào {dataDir}/runtime', async () => {
  const dataDir = tmp('sbok-rt-');
  const req = path.join(dataDir, 'req.txt');
  fs.writeFileSync(req, '# x\nnumpy==1.26.4\n');
  const m = fakeMachine(dataDir, new Set([`python -c ${TTS_IMPORT}`, 'ffmpeg -version']));
  const r = await ensureRuntime({ dataDir, log: () => {}, deps: { run: m.run, download: m.dl, requirementsFile: req } });
  assert.deepStrictEqual(r, { pythonPath: m.py, ffmpegPath: m.ff, errors: [] });
  assert.deepStrictEqual(m.downloads, [MANIFEST.python.name, MANIFEST.getPip.name, MANIFEST.ffmpeg.name, 'model']);
});

test('chỉ thiếu ffmpeg trong runtime → chỉ cài ffmpeg vào {dataDir}/runtime', async () => {
  const dataDir = tmp('sbok-rt-');
  const has = new Set();
  const m = fakeMachine(dataDir, has);
  has.add(`${m.py} -c ${TTS_IMPORT}`).add('model');
  const r = await ensureRuntime({ dataDir, log: () => {}, deps: { run: m.run, download: m.dl } });
  assert.deepStrictEqual(r, { pythonPath: m.py, ffmpegPath: m.ff, errors: [] });
  assert.deepStrictEqual(m.downloads, [MANIFEST.ffmpeg.name]);
});

test('TC-33: chưa có danh sách gói ghim hoặc tải lỗi → errors, path null (đỏ, không nhận job)', async () => {
  const dataDir = tmp('sbok-rt-');
  const req = path.join(dataDir, 'req.txt');
  fs.writeFileSync(req, '# chưa có gói\n');
  const m = fakeMachine(dataDir, new Set());
  const failDl = async () => { throw new Error('SHA-256 không khớp'); };
  const r = await ensureRuntime({ dataDir, log: () => {}, deps: { run: m.run, download: failDl, requirementsFile: req } });
  assert.strictEqual(r.pythonPath, null);
  assert.strictEqual(r.ffmpegPath, null);
  assert.match(r.errors[0], /chưa có danh sách gói pip/);
  assert.match(r.errors[1], /SHA-256 không khớp/);
});
