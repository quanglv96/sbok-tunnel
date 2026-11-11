# sbok-tunnel

Worker SBOK chạy trên máy cá nhân (Electron): Cloudflare Tunnel, sandbox PDF, tách chương,
VieNeu-TTS, đẩy MP3 lên R2.

## Yêu cầu
- Node.js >= 20
- `cloudflared`
- Python 3 + `pip install vieneu-tts soundfile numpy`
- `ffmpeg`

## Cấu hình
Các biến môi trường liệt kê trong `.env.example`. Ứng dụng không tự đọc file `.env`:
đặt biến cho tiến trình trước khi chạy (ví dụ PowerShell: `$env:SBOK_WORKER_PORT="7860"`).

## Lệnh build
```bash
# Cài dependency
npm ci

# Chạy unit test (node:test)
npm test

# Chạy ứng dụng
npm start

# Chạy thử riêng script TTS
python python/tts_runner.py --help
```
