# sbok-tunnel

Worker SBOK chạy trên máy cá nhân (Electron): Cloudflare Tunnel, sandbox PDF, tách chương,
VieNeu-TTS, đẩy MP3 lên R2.

## Yêu cầu
- Node.js >= 20
- `cloudflared` (chỉ khi có `CLOUDFLARE_TUNNEL_TOKEN`)
- Python, VieNeu-TTS, ffmpeg: app tự kiểm và tự cài (xem dưới)

## Môi trường tự cài (BR-15)
Lần chạy đầu app hỏi thư mục data (huỷ = `{userData}/data`), lưu ở `{userData}/settings.json`.
Mỗi lần khởi động và khi bấm "Kiểm tra lại", app kiểm từng công cụ theo thứ tự settings → `{dataDir}/runtime`
→ PATH; thiếu cái nào thì tự cài cái đó vào `{dataDir}/runtime`. Đang kiểm/cài: vàng, không nhận job;
lỗi: đỏ, nút "Thử lại".

Chỉ tải từ host trong `ALLOWED_HOSTS` (`src/runtimeSetup.js`), chỉ HTTPS, file tải phải khớp SHA-256 ghim.
Danh sách thư viện cố định:

| thành phần | phiên bản | loại | nguồn | SHA-256 |
|---|---|---|---|---|
| Python embeddable win64 | 3.11.9 (chờ C-0a xác nhận) | file tải | `www.python.org/ftp/python/` | chưa ghim |
| get-pip.py | chưa ghim | file tải | `bootstrap.pypa.io` | chưa ghim |
| ffmpeg win64 | chưa ghim | file tải | `github.com/BtbN/FFmpeg-Builds/releases` | chưa ghim |
| VieNeu-TTS + gói kéo theo | `python/requirements-runtime.txt` (`==`) | pip | `pypi.org` | pip kiểm |

Mục chưa ghim thì app không tải, báo đỏ. Ghim xong (C-0a) cập nhật `MANIFEST`, file requirements và bảng này.

## Cấu hình
Chép `.env.example` thành `.env` rồi điền giá trị. Ứng dụng tự đọc `.env` ở thư mục chạy lệnh
(`npm start`) hoặc cạnh file `.exe` (bản đóng gói). Biến đã đặt cho tiến trình được ưu tiên hơn `.env`.

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
