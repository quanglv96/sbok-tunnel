'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { loadConfig, loadEnvFile } = require('./src/config');
const { startupCheck } = require('./src/startupCheck');
const { createTunnelManager } = require('./src/tunnelManager');
const { createJobServer } = require('./src/jobServer');
const { createBackendClient } = require('./src/backendClient');
const { createR2Uploader } = require('./src/r2Uploader');
const { processJob } = require('./src/pipeline');

// Chạy dev: `.env` ở thư mục chạy lệnh; bản đóng gói: `.env` cạnh file .exe
const envFile = loadEnvFile([process.cwd(), path.dirname(process.execPath)]);
const config = loadConfig();
const state = { checks: [], ready: false, tunnel: 'STOPPED', logs: [] };
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
  if (win) win.webContents.send('sbok:state', { checks: state.checks, ready: state.ready, tunnel: state.tunnel });
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
  const result = await startupCheck(config);
  state.checks = result.checks;
  state.ready = result.ok;
  result.checks.forEach((c) => log(`[startup] ${c.ok ? 'OK ' : 'LỖI'} ${c.name}: ${c.detail}`));
  pushState();

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
    log('CLOUDFLARE_TUNNEL_TOKEN chưa cấu hình: không mở tunnel');
  }
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
    boot().catch((err) => log(`Khởi động lỗi: ${err.message}`));
  });
  app.on('second-instance', () => win && win.show());
  app.on('window-all-closed', (e) => e.preventDefault());
}
