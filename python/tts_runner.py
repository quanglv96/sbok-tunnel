"""SBOK TTS: đọc file .txt một chương, sinh giọng bằng SDK `vieneu` (mặc định v3 Turbo), xuất MP3 (64-128 kbps) qua ffmpeg.

In ra stdout dòng JSON cuối: {"durationSec": <int>}. Lỗi -> mã thoát khác 0, chi tiết ở stderr.
--batch <file.json> ([{"in", "out"}, ...]): nạp model 1 lần, mỗi chương xong in {"index": i, "durationSec": n}.
SDK: `from vieneu import Vieneu`; không có GPU thì chạy ONNX Runtime trên CPU, không cần torch (README tác giả).
Env VIENEU_MODEL: trống = v3 Turbo (48 kHz); "v3nano" = v3 Nano (24 kHz, nhanh hơn, chất lượng thấp hơn).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

ALLOWED_BITRATES = {"64k", "96k", "128k"}
MAX_CHUNK = 200  # #135: đoạn ngắn hơn để chèn khoảng lặng giữa các câu
SAMPLE_RATES = {"": 48000, "v3nano": 24000}
DEFAULT_VOICE = "Thiện Minh"  # Nam · Bắc · Phong cách kể chuyện (preset nổi bật của v3 Turbo)


def chunks(text):
    """Mỗi câu một đoạn (#147: không gộp nhiều câu, để khoảng lặng nằm giữa mọi câu).

    Câu dài hơn MAX_CHUNK cắt ở dấu phẩy, không được thì ở khoảng trắng gần nhất, cuối cùng mới cắt cứng.
    """
    for sentence in re.split(r"(?<=[.!?…;:])\s+", re.sub(r"\s+", " ", text).strip()):
        while len(sentence) > MAX_CHUNK:
            cut = sentence.rfind(", ", 0, MAX_CHUNK) + 1 or sentence.rfind(" ", 0, MAX_CHUNK)
            cut = cut if cut > 0 else MAX_CHUNK
            yield sentence[:cut].strip()
            sentence = sentence[cut:].strip()
        if sentence:
            yield sentence


def use_real_files_in_hf_cache():
    """ONNX Runtime chặn file .data ngoài thư mục model sau khi theo symlink (snapshot -> blobs của HF cache).

    Tắt symlink cho lần tải mới (HF chuyển blob thành file thật trong snapshot) và thay symlink đã có bằng file thật.
    """
    import shutil
    import huggingface_hub.file_download as hf_download
    from huggingface_hub.constants import HF_HUB_CACHE

    hf_download.are_symlinks_supported = lambda *_args, **_kwargs: False
    if not os.path.isdir(HF_HUB_CACHE):
        return
    for repo in os.listdir(HF_HUB_CACHE):
        for root, _dirs, files in os.walk(os.path.join(HF_HUB_CACHE, repo, "snapshots")):
            for name in files:
                link = os.path.join(root, name)
                target = os.path.realpath(link)
                if os.path.islink(link) and os.path.isfile(target):
                    shutil.copyfile(target, link + ".tmp")
                    os.replace(link + ".tmp", link)


def write_api_info(tts):
    """#141: ghi chữ ký infer, thuộc tính công khai và danh sách giọng (nếu SDK có) ra {HF_HOME}/../vieneu-api.txt.

    Chỉ để chọn giọng; lỗi ở đây không làm hỏng prefetch.
    """
    import pydoc
    home = os.environ.get("HF_HOME")
    if not home:
        return
    try:
        members = [m for m in dir(tts) if not m.startswith("_")]
        lines = [pydoc.render_doc(tts.infer, renderer=pydoc.plaintext), "members: " + json.dumps(members)]
        for name in members:
            attr = getattr(tts, name, None)
            if "voice" not in name.lower():
                continue
            try:
                value = attr() if callable(attr) else attr
            except Exception as err:  # method cần tham số hoặc lỗi: chỉ ghi lại
                value = f"<{type(err).__name__}: {err}>"
            lines.append(f"{name}: {value!r}")
        with open(os.path.join(os.path.dirname(home), "vieneu-api.txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    except Exception as err:
        print(f"[prefetch] không ghi được vieneu-api.txt: {err}", file=sys.stderr)


def disable_codec_arena(tts, ort=None):
    """Tạo lại session codec decoder của SDK với enable_cpu_mem_arena=False.

    vieneu 3.8.4 tạo mọi session ONNX với arena CPU bật; codec decoder nhận đầu vào dài ngắn khác nhau theo câu nên
    arena nới dần tới khi `bad allocation`. Tìm object có `sess_codec_dec` + `_so` (thuộc tính nội bộ, sâu tối đa 3
    tầng); không thấy hoặc lỗi thì ghi log và giữ session cũ (không làm hỏng job). Trả True nếu đã thay.
    """
    try:
        if ort is None:
            import onnxruntime as ort
        level = [tts]
        for _ in range(3):
            for obj in level:
                old = getattr(obj, "sess_codec_dec", None)
                so = getattr(obj, "_so", None)
                if old is not None and so is not None:
                    so.enable_cpu_mem_arena = False
                    obj.sess_codec_dec = ort.InferenceSession(old._model_path, so, providers=old.get_providers())
                    return True
            level = [v for o in level for v in getattr(o, "__dict__", {}).values() if hasattr(v, "__dict__")]
        print("[tts] không thấy sess_codec_dec trong SDK, giữ arena mặc định", file=sys.stderr)
    except Exception as err:
        print(f"[tts] không tắt được arena của codec decoder: {err}", file=sys.stderr)
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="src")
    parser.add_argument("--out", dest="dst")
    parser.add_argument("--prefetch", action="store_true", help="chỉ tải/nạp model vào HF_HOME rồi thoát (#129)")
    parser.add_argument("--batch", help="file JSON [{in, out}, ...]: nạp model 1 lần cho cả job (P1, AC-23)")
    parser.add_argument("--bitrate", default="96k")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    if not args.prefetch and not args.batch and not (args.src and args.dst):
        parser.error("cần --in và --out (hoặc --batch, --prefetch)")
    if args.bitrate not in ALLOWED_BITRATES:
        sys.exit(f"bitrate phải thuộc {sorted(ALLOWED_BITRATES)}")
    mode = os.environ.get("VIENEU_MODEL", "").strip()
    if mode not in SAMPLE_RATES:
        sys.exit(f"VIENEU_MODEL phải để trống (v3 Turbo) hoặc là v3nano, nhận: {mode}")
    # #135: tốc độ đọc (atempo của ffmpeg, giữ cao độ) và khoảng lặng giữa các đoạn
    try:
        speed = float(os.environ.get("SBOK_TTS_SPEED", "").strip() or "0.9")
        pause_ms = int(os.environ.get("SBOK_TTS_PAUSE_MS", "").strip() or "400")
    except ValueError:
        sys.exit("SBOK_TTS_SPEED phải là số (0.7-1.2), SBOK_TTS_PAUSE_MS phải là số nguyên (0-2000)")
    if not (0.7 <= speed <= 1.2 and 0 <= pause_ms <= 2000):
        sys.exit("SBOK_TTS_SPEED phải trong 0.7-1.2, SBOK_TTS_PAUSE_MS trong 0-2000")

    from vieneu import Vieneu

    use_real_files_in_hf_cache()
    tts = Vieneu(mode=mode) if mode else Vieneu()
    if args.prefetch:
        write_api_info(tts)
        return
    disable_codec_arena(tts)
    # #145: giọng preset của SDK (list_preset_voices -> (nhãn, tên)); mặc định giọng kể chuyện
    voice = os.environ.get("SBOK_TTS_VOICE", "").strip() or DEFAULT_VOICE
    names = [name for _label, name in tts.list_preset_voices()]
    if voice not in names:
        sys.exit(f"SBOK_TTS_VOICE không có trong giọng preset: {voice}. Hợp lệ: {', '.join(names)}")
    opts = dict(voice=voice, mode=mode, speed=speed, pause_ms=pause_ms, bitrate=args.bitrate, ffmpeg=args.ffmpeg)
    if not args.batch:
        print(json.dumps({"durationSec": synthesize_one(tts, args.src, args.dst, **opts)}))
        return
    # P1 (AC-23): model đã nạp 1 lần; mỗi chương xong in {"index": i (từ 0), "durationSec": n}. Lỗi chương nào thì
    # thoát mã khác 0 ngay (job FAILED).
    with open(args.batch, encoding="utf-8") as f:
        items = json.load(f)
    for i, item in enumerate(items):
        print(f"chapter {i + 1}/{len(items)}", file=sys.stderr, flush=True)
        duration = synthesize_one(tts, item["in"], item["out"], **opts)
        print(json.dumps({"index": i, "durationSec": duration}), flush=True)


def synthesize_one(tts, src, dst, voice, mode, speed, pause_ms, bitrate, ffmpeg):
    """Một chương: .txt -> MP3. Trả thời lượng (giây, đã tính tốc độ)."""
    import numpy as np

    with open(src, encoding="utf-8") as f:
        text = f.read()

    parts = list(chunks(text))
    step = max(1, len(parts) // 10)
    pieces = []
    silence = np.zeros(int(SAMPLE_RATES[mode] * pause_ms / 1000), dtype=np.float32)
    for i, part in enumerate(parts, 1):
        if pieces:
            pieces.append(silence)
        pieces.append(np.asarray(tts.infer(part, voice=voice), dtype=np.float32))
        if i % step == 0 or i == len(parts):
            print(f"chunk {i}/{len(parts)}", file=sys.stderr, flush=True)  # ASCII: stderr có thể là cp1252
    if not pieces:
        sys.exit("chương rỗng")

    audio = np.concatenate(pieces)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav = tmp.name
    try:
        tts.save(audio, wav)
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", wav, "-filter:a", f"atempo={speed}", "-ac", "1",
                        "-codec:a", "libmp3lame", "-b:a", bitrate, dst], check=True)
    finally:
        os.remove(wav)
    return int(round(len(audio) / SAMPLE_RATES[mode] / speed))


if __name__ == "__main__":
    main()
