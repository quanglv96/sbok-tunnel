# sbok-tunnel

Worker SBOK chạy trên máy cá nhân (Electron): Cloudflare Tunnel, sandbox PDF, tách chương,
VieNeu-TTS, đẩy MP3 lên R2.

## Yêu cầu
- Node.js >= 20
- `cloudflared`
- Python 3 + `pip install vieneu-tts soundfile numpy`
- `ffmpeg`

## Cấu hình
Chép `.env.example` thành `.env` rồi điền giá trị. Ứng dụng tự đọc `.env` ở thư mục chạy lệnh
(`npm start`) hoặc cạnh file `.exe` (bản đóng gói). Biến đã đặt cho tiến trình được ưu tiên hơn `.env`.
Python không có trong PATH (lỗi `spawn python ENOENT`) thì đặt `PYTHON_PATH` là đường dẫn đầy đủ tới
`python.exe` (của venv đã cài VieNeu-TTS).

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
