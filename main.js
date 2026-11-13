'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog } = require('electron');
const path = require('path');
const { loadConfig, loadEnvFile } = require('./src/config');
const { startupCheck } = require('./src/startupCheck');
const { readSettings, writeSettings } = require('./src/settings');
const { ensureRuntime } = require('./src/runtimeSetup');
const { createTunnelManager } = require('./src/tunnelManager');
const { createJobServer } = require('./src/jobServer');
const { createBackendClient } = require('./src/backendClient');
const { createR2Uploader } = require('./src/r2Uploader');
const { processJob } = require('./src/pipeline');

// Chạy dev: `.env` ở thư mục chạy lệnh; bản đóng gói: `.env` cạnh file .exe
const envFile = loadEnvFile([process.cwd(), path.dirname(process.execPath)]);
let config = null;
// setup: checking | installing | ok | error (BR-15: đang kiểm/cài thì vàng, không nhận job)
const state = { checks: [], ready: false, setup: 'checking', dataDir: '', tunnel: 'STOPPED', logs: [] };
let preparing = null;
let win = null;
let tray = null;
let quitting = false;

function log(line) {
  const entry = `${new Date().toISOString()} ${line}`;
  console.log(entry);
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.shift();
  if (win) win.webContents.send('sbok:log', entry);
}

function pushState() {
  if (win) {
    const { checks, ready, setup, dataDir, tunnel } = state;
    win.webContents.send('sbok:state', { checks, ready, setup, dataDir, tunnel });
  }
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

async function chooseDataDir() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Chọn thư mục data của SBOK Worker',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

/** BR-15: kiểm Python/VieNeu-TTS/ffmpeg, thiếu thì tự cài, rồi startup check. Gọi khi khởi động và khi bấm "Kiểm tra lại". */
function prepare() {
  if (preparing) return preparing;
  preparing = (async () => {
    state.ready = false;
    state.setup = 'installing';
    pushState();
    const file = settingsFile();
    const settings = readSettings(file);
    const rt = await ensureRuntime({ dataDir: state.dataDir, log });
    // #109: không rơi về PATH; thiếu thì trỏ vào bản trong {dataDir}/runtime để startup check báo đỏ
    const rtDir = path.join(state.dataDir, 'runtime');
    config.pythonPath = rt.pythonPath || path.join(rtDir, 'python', 'python.exe');
    config.ffmpegPath = rt.ffmpegPath || path.join(rtDir, 'ffmpeg', 'bin', 'ffmpeg.exe');
    writeSettings(file, {
      ...settings,
      dataDir: state.dataDir,
      pythonPath: rt.pythonPath || undefined,
      ffmpegPath: rt.ffmpegPath || undefined,
      appVersion: app.getVersion(),
      checkedAt: new Date().toISOString(),
    });
    const result = await startupCheck(config);
    const setupCheck = { name: 'Cài môi trường', ok: rt.errors.length === 0, detail: rt.errors.join('; ') || 'đủ' };
    state.checks = [...result.checks, setupCheck];
    state.ready = result.ok && setupCheck.ok;
    state.setup = setupCheck.ok ? 'ok' : 'error';
    state.checks.forEach((c) => log(`[startup] ${c.ok ? 'OK ' : 'LỖI'} ${c.name}: ${c.detail}`));
  })().catch((err) => {
    state.ready = false;
    state.setup = 'error';
    log(`[setup] lỗi: ${err.message}`);
  }).finally(() => {
    preparing = null;
    pushState();
  });
  return preparing;
}

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 640,
    title: 'SBOK Worker',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Chạy 24/7: đóng cửa sổ chỉ ẩn xuống tray
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

async function boot() {
  log(envFile ? `Đã nạp env từ ${envFile}` : 'Không thấy file .env: chỉ dùng biến môi trường của tiến trình');
  const file = settingsFile();
  const settings = readSettings(file);
  state.dataDir = settings.dataDir || (await chooseDataDir()) || path.join(app.getPath('userData'), 'data');
  if (settings.dataDir !== state.dataDir) writeSettings(file, { ...settings, dataDir: state.dataDir });
  log(`Thư mục data: ${state.dataDir}`);
  config = loadConfig(process.env, path.join(state.dataDir, 'work'));
  process.env.HF_HOME = path.join(state.dataDir, 'runtime', 'hf');

  const backend = createBackendClient(config, { log });
  const uploader = createR2Uploader(config.r2, { log });
  const server = createJobServer(config, {
    isReady: () => state.ready,
    runJob: (job) => processJob(job, { config, backend, uploader, log }),
    log,
  });
  await server.listen();
  log(`Job server nghe ở 127.0.0.1:${config.port}`);

  if (config.tunnelToken) {
    createTunnelManager(config, {
      log,
      onState: (s) => {
        state.tunnel = s;
        pushState();
      },
    }).start();
  } else {
    log(`Chế độ local (không có CLOUDFLARE_TUNNEL_TOKEN): đặt SBOK_WORKER_URL=http://localhost:${config.port} ở sbok-service`);
  }
  await prepare();
}

async function changeDataDir() {
  const dir = await chooseDataDir();
  if (!dir || dir === state.dataDir) return false;
  writeSettings(settingsFile(), { ...readSettings(settingsFile()), dataDir: dir, pythonPath: undefined, ffmpegPath: undefined });
  quitting = true;
  app.relaunch();
  app.exit(0);
  return true;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    createWindow();
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip('SBOK Worker');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Mở', click: () => win.show() },
      { label: 'Thoát', click: () => { quitting = true; app.quit(); } },
    ]));
    ipcMain.handle('sbok:snapshot', () => state);
    ipcMain.handle('sbok:recheck', () => (config ? prepare() : null));
    ipcMain.handle('sbok:change-data-dir', () => changeDataDir());
    boot().catch((err) => log(`Khởi động lỗi: ${err.message}`));
  });
  app.on('second-instance', () => win && win.show());
  app.on('window-all-closed', (e) => e.preventDefault());
}
