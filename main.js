'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog } = require('electron');
const path = require('path');
const { loadConfig, loadEnvFile } = require('./src/config');
const { startupCheck } = require('./src/startupCheck');
const { readSettings, writeSettings } = require('./src/settings');
const { ensureRuntime } = require('./src/runtimeSetup');
const { createTunnelManager } = require('./src/tunnelManager');
const { createJobServer } = require('./src/jobServer');
const { createBackendClient, backendBootLines } = require('./src/backendClient');
const { createR2Uploader } = require('./src/r2Uploader');
const { processJob, uploadChapter } = require('./src/pipeline');
const { createRetryQueue } = require('./src/retryQueue');
const { createTtsController, resolveTts } = require('./src/ttsSettings');
const { preview, prefetchModel } = require('./src/tts/ttsRunner');
const { runtimeEnv } = require('./src/runtimeSetup');

// Chạy dev: `.env` ở thư mục chạy lệnh; bản đóng gói: `.env` cạnh file .exe
const envFile = loadEnvFile([process.cwd(), path.dirname(process.execPath)]);
let config = null;
// setup: checking | installing | ok | error (BR-15: đang kiểm/cài thì vàng, không nhận job)
// progress: null | { step, steps, label, received, total } – thanh tiến độ tải/cài thư viện (#119)
// busy: có job đang chạy (chặn "Nghe thử", #208)
const state = {
  checks: [], ready: false, setup: 'checking', dataDir: '', tunnel: 'STOPPED', logs: [], progress: null, busy: false,
};
let preparing = null;
let jobServer = null;
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
    const { checks, ready, setup, dataDir, tunnel, progress, busy } = state;
    win.webContents.send('sbok:state', { checks, ready, setup, dataDir, tunnel, progress, busy });
  }
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

// #208 (BR-17): màn cấu hình đọc; main kiểm hợp lệ, renderer chỉ gửi giá trị
const ttsController = createTtsController({
  settingsFile,
  runtimeDir: () => path.join(state.dataDir, 'runtime'),
  isReady: () => Boolean(config) && state.ready,
  isBusy: () => Boolean(jobServer && jobServer.isBusy()),
  prefetch: (model) => prefetchModel(config.pythonPath, runtimeEnv(state.dataDir), model, log),
  synthPreview: (tts, text) => preview(config, tts, text, path.join(config.workDir, 'preview'), log),
  store: { readSettings, writeSettings },
  log,
});

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
    const onProgress = (p) => {
      state.progress = p;
      pushState();
    };
    const rt = await ensureRuntime({ dataDir: state.dataDir, log, onProgress });
    state.progress = null;
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
    state.progress = null;
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

  for (const line of backendBootLines(config)) log(line);
  const backend = createBackendClient(config, { log });
  const uploader = createR2Uploader(config.r2, { log });
  const retry = createRetryQueue({ jobsDir: config.jobsDir, enqueue: (job) => jobServer.enqueue(job), log });
  jobServer = createJobServer(config, {
    isReady: () => state.ready,
    // BR-17: job mới chụp cấu hình đọc hiện hành; lượt đọc tiếp dùng cấu hình đã chụp trong job.json
    runJob: async (job) => {
      state.busy = true;
      pushState();
      try {
        await processJob(job, {
          config, backend, uploader, log,
          tts: job.resume ? null : resolveTts(readSettings(settingsFile()), process.env),
          scheduleRetry: (s) => retry.schedule(s),
          cancelRetry: (id) => retry.cancel(id),
        });
      } finally {
        setImmediate(() => {
          state.busy = jobServer.isBusy();
          pushState();
        });
      }
    },
    onQueued: (job, position) => backend.progress(job.taskId, 'QUEUED', `Máy xử lý đã nhận PDF, vị trí hàng đợi ${position}`),
    onUpload: (taskId, index) => uploadChapter(taskId, index, { config, backend, uploader, log,
      cancelRetry: (id) => retry.cancel(id) }),
    log,
  });
  await jobServer.listen();
  log(`Job server nghe ở 127.0.0.1:${config.port}`);
  retry.load();

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
    ipcMain.handle('tts:get', () => ttsController.get());
    ipcMain.handle('tts:voices', (_e, model) => ttsController.voices(model));
    ipcMain.handle('tts:save', (_e, input) => ttsController.save(input));
    ipcMain.handle('tts:preview', (_e, input) => ttsController.preview(input));
    boot().catch((err) => log(`Khởi động lỗi: ${err.message}`));
  });
  app.on('second-instance', () => win && win.show());
  app.on('window-all-closed', (e) => e.preventDefault());
}
