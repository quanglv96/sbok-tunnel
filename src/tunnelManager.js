'use strict';

const { spawn } = require('child_process');

const HEALTH_INTERVAL_MS = 15_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 15_000;

/** Chờ trước lần khởi động lại thứ {@code attempt} (0-based): 1 s, 2 s, 4 s ... trần 15 s (BR-11: nối lại ≤ 30 s). */
function backoffMs(attempt) {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt), BACKOFF_CAP_MS);
}

/**
 * Chạy cloudflared (token qua env TUNNEL_TOKEN, không lộ trên command line), health check /ready mỗi 15 s, tự khởi
 * động lại có backoff khi tiến trình thoát hoặc health lỗi. Mỗi lần rớt đều log.
 */
function createTunnelManager(config, { log = console.log, spawnImpl = spawn, fetchImpl = fetch, onState = () => {} } = {}) {
  let child = null;
  let attempt = 0;
  let stopped = true;
  let restartTimer = null;
  let healthTimer = null;

  function start() {
    stopped = false;
    launch();
    healthTimer = setInterval(checkHealth, HEALTH_INTERVAL_MS);
  }

  function launch() {
    if (stopped) return;
    child = spawnImpl(config.cloudflaredPath,
      ['tunnel', '--no-autoupdate', '--metrics', `127.0.0.1:${config.metricsPort}`, 'run'],
      { env: { ...process.env, TUNNEL_TOKEN: config.tunnelToken }, windowsHide: true });
    child.stderr && child.stderr.on('data', () => {});
    child.on('exit', (code) => handleDrop(`cloudflared thoát (mã ${code})`));
    child.on('error', (err) => handleDrop(`cloudflared lỗi: ${err.message}`));
    onState('CONNECTING');
  }

  function handleDrop(reason) {
    child = null;
    if (stopped || restartTimer) return;
    const wait = backoffMs(attempt++);
    log(`Tunnel rớt: ${reason}; khởi động lại sau ${wait} ms`);
    onState('RECONNECTING');
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launch();
    }, wait);
  }

  async function checkHealth() {
    if (!child) return;
    try {
      const res = await fetchImpl(`http://127.0.0.1:${config.metricsPort}/ready`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      attempt = 0;
      onState('CONNECTED');
    } catch (err) {
      log(`Tunnel health lỗi: ${err.message}`);
      const current = child;
      child = null;
      current.removeAllListeners('exit');
      current.kill();
      handleDrop('health check lỗi');
    }
  }

  function stop() {
    stopped = true;
    clearInterval(healthTimer);
    clearTimeout(restartTimer);
    restartTimer = null;
    if (child) child.kill();
  }

  return { start, stop, checkHealth };
}

module.exports = { createTunnelManager, backoffMs, BACKOFF_CAP_MS };
