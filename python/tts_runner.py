"""SBOK TTS: đọc file .txt một chương, sinh giọng bằng SDK `vieneu` (mặc định v3 Turbo), xuất MP3 (64-128 kbps) qua ffmpeg.

In ra stdout dòng JSON cuối: {"durationSec": <int>}. Lỗi -> mã thoát khác 0, chi tiết ở stderr.
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
MAX_CHUNK = 400
SAMPLE_RATES = {"": 48000, "v3nano": 24000}


def chunks(text):
    """Cắt theo câu, mỗi đoạn ≤ MAX_CHUNK ký tự (TTS ổn định hơn với câu ngắn)."""
    buf = ""
    for sentence in re.split(r"(?<=[.!?…;:])\s+", re.sub(r"\s+", " ", text).strip()):
        if len(buf) + len(sentence) + 1 > MAX_CHUNK and buf:
            yield buf
            buf = ""
        while len(sentence) > MAX_CHUNK:
            yield sentence[:MAX_CHUNK]
            sentence = sentence[MAX_CHUNK:]
        buf = f"{buf} {sentence}".strip()
    if buf:
        yield buf


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="src", required=True)
    parser.add_argument("--out", dest="dst", required=True)
    parser.add_argument("--bitrate", default="96k")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    if args.bitrate not in ALLOWED_BITRATES:
        sys.exit(f"bitrate phải thuộc {sorted(ALLOWED_BITRATES)}")
    mode = os.environ.get("VIENEU_MODEL", "").strip()
    if mode not in SAMPLE_RATES:
        sys.exit(f"VIENEU_MODEL phải để trống (v3 Turbo) hoặc là v3nano, nhận: {mode}")

    import numpy as np
    from vieneu import Vieneu

    tts = Vieneu(mode=mode) if mode else Vieneu()
    with open(args.src, encoding="utf-8") as f:
        text = f.read()

    pieces = [np.asarray(tts.infer(part), dtype=np.float32) for part in chunks(text)]
    if not pieces:
        sys.exit("chương rỗng")

    audio = np.concatenate(pieces)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav = tmp.name
    try:
        tts.save(audio, wav)
        subprocess.run([args.ffmpeg, "-y", "-loglevel", "error", "-i", wav, "-ac", "1", "-codec:a", "libmp3lame",
                        "-b:a", args.bitrate, args.dst], check=True)
    finally:
        os.remove(wav)
    print(json.dumps({"durationSec": int(round(len(audio) / SAMPLE_RATES[mode]))}))


if __name__ == "__main__":
    main()
