"""SBOK TTS: đọc file .txt một chương, sinh giọng bằng VieNeu-TTS v3 Turbo, xuất MP3 (64-128 kbps) qua ffmpeg.

In ra stdout dòng JSON cuối: {"durationSec": <int>}. Lỗi -> mã thoát khác 0, chi tiết ở stderr.
Model chọn qua env VIENEU_MODEL (mặc định v3 Turbo). Cài: pip install vieneu-tts soundfile numpy; cần ffmpeg.
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

    import numpy as np
    import soundfile as sf
    from vieneu_tts import VieNeuTTS

    tts = VieNeuTTS(os.environ.get("VIENEU_MODEL", "vieneu-tts-v3-turbo"))
    with open(args.src, encoding="utf-8") as f:
        text = f.read()

    pieces, sample_rate = [], None
    for part in chunks(text):
        audio, sr = tts.infer(part)
        sample_rate = sample_rate or sr
        pieces.append(np.asarray(audio, dtype=np.float32))
    if not pieces:
        sys.exit("chương rỗng")

    audio = np.concatenate(pieces)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav = tmp.name
    try:
        sf.write(wav, audio, sample_rate)
        subprocess.run([args.ffmpeg, "-y", "-loglevel", "error", "-i", wav, "-ac", "1", "-codec:a", "libmp3lame",
                        "-b:a", args.bitrate, args.dst], check=True)
    finally:
        os.remove(wav)
    print(json.dumps({"durationSec": int(round(len(audio) / sample_rate))}))


if __name__ == "__main__":
    main()
