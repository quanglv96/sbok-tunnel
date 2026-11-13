# sbok-tunnel

Worker SBOK chạy trên máy cá nhân (Electron): Cloudflare Tunnel, sandbox PDF, tách chương,
VieNeu-TTS, đẩy MP3 lên R2.

## Yêu cầu
- Node.js >= 20
- `cloudflared` (chỉ khi có `CLOUDFLARE_TUNNEL_TOKEN`)
- Python, VieNeu-TTS, ffmpeg: app tự kiểm và tự cài (xem dưới)

## Môi trường tự cài (BR-15)
Lần chạy đầu app hỏi thư mục data (huỷ = `{userData}/data`), lưu ở `{userData}/settings.json`.
Mỗi lần khởi động và khi bấm "Kiểm tra lại", app kiểm từng công cụ theo thứ tự settings → `{dataDir}/runtime`;
thiếu cái nào thì tự cài cái đó vào `{dataDir}/runtime`. **Không dùng Python/ffmpeg trên PATH.** Công cụ chỉ được
nhận khi chạy thử thành công. Đang kiểm/cài: vàng, có thanh tiến độ, không nhận job; lỗi: đỏ, nút "Thử lại".

Chỉ tải qua HTTPS từ host trong `ALLOWED_HOSTS` (`src/runtimeSetup.js`, kiểm lại ở mỗi redirect). Phiên bản ghim
qua URL trong `MANIFEST`. `sha256` là tuỳ chọn: nếu đã ghim thì file tải phải khớp (sai thì xoá file, báo đỏ);
nếu để trống thì không kiểm hash. Danh sách thư viện:

| thành phần | phiên bản | loại | nguồn | SHA-256 |
|---|---|---|---|---|
| Python embeddable win64 | 3.11.9 | file tải | `www.python.org/ftp/python/3.11.9/` | tuỳ chọn |
| pip (qua get-pip.py) | 24.3.1 | file tải + pip | `bootstrap.pypa.io` | tuỳ chọn |
| ffmpeg win64 essentials (GyanD) | 7.1 | file tải | `github.com/GyanD/codexffmpeg/releases` | tuỳ chọn |
| VieNeu-TTS (`vieneu`) + gói kéo theo | `python/requirements-runtime.txt` | pip | `pypi.org/simple` | pip kiểm |
| Model VieNeu-TTS | do SDK chọn | tải lúc cài (prefetch) | `huggingface.co` | — |

pip chạy với `--isolated --no-input --no-cache-dir --index-url https://pypi.org/simple`, env bỏ `PIP_*`/`PYTHON*`,
UTF-8 mode (`PYTHONUTF8=1`). pip tự giải gói kéo theo. Không cài torch/espeak-ng: SDK `vieneu` chạy ONNX Runtime
trên CPU. Model tải sẵn lúc cài vào `{dataDir}/runtime/hf` (file thật, không symlink), job chạy offline.

## Biến TTS (tuỳ chọn, trong `.env`)
| biến | mặc định | giới hạn |
|---|---|---|
| `VIENEU_MODEL` | trống (v3 Turbo, 48 kHz) | trống hoặc `v3nano` (24 kHz) |
| `SBOK_TTS_VOICE` | `Thiện Minh` | tên có trong `list_preset_voices()` của SDK |
| `SBOK_TTS_SPEED` | `0.9` | 0.7–1.2 (ffmpeg `atempo`, giữ cao độ) |
| `SBOK_TTS_PAUSE_MS` | `400` | 0–2000 (khoảng lặng giữa các câu) |

Giá trị sai thì job lỗi, có thông báo.

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
