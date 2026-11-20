"""Unit test disable_codec_arena, infer_safe với engine/onnxruntime giả (chạy: python -I python/test_tts_runner.py)."""
import contextlib
import io
import itertools
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tts_runner  # noqa: E402


class FakeSession:
    def __init__(self, path, so=None, providers=None):
        self._model_path = path
        self.so = so
        self.providers = providers

    def get_providers(self):
        return ["CPUExecutionProvider"]


class FakeOrt:
    InferenceSession = FakeSession


class Obj:
    pass


def fake_tts():
    eng = Obj()
    eng._so = Obj()
    eng._so.enable_cpu_mem_arena = True
    eng.sess_codec_dec = FakeSession("codec_decode.onnx")
    tts = Obj()
    tts.wrapper = Obj()
    tts.wrapper.engine = eng
    return tts, eng


class DisableCodecArenaTest(unittest.TestCase):
    def test_replaces_session_without_arena(self):
        tts, eng = fake_tts()
        old = eng.sess_codec_dec
        self.assertTrue(tts_runner.disable_codec_arena(tts, FakeOrt))
        self.assertIsNot(eng.sess_codec_dec, old)
        self.assertEqual(eng.sess_codec_dec._model_path, "codec_decode.onnx")
        self.assertFalse(eng._so.enable_cpu_mem_arena)
        self.assertEqual(eng.sess_codec_dec.providers, ["CPUExecutionProvider"])

    def test_missing_attribute_keeps_job_running(self):
        self.assertFalse(tts_runner.disable_codec_arena(Obj(), FakeOrt))

    def test_session_error_keeps_old_session(self):
        tts, eng = fake_tts()
        old = eng.sess_codec_dec

        class BrokenOrt:
            def InferenceSession(*_args, **_kwargs):
                raise RuntimeError("load failed")

        self.assertFalse(tts_runner.disable_codec_arena(tts, BrokenOrt))
        self.assertIs(eng.sess_codec_dec, old)


class FakeTts:
    """infer trả list mã ký tự (đánh dấu nội dung); ném `error` khi đoạn dài hơn `limit`."""

    def __init__(self, limit, error=None):
        self.limit = limit
        self.error = error or RuntimeError("[ONNXRuntimeError] : 6 : RUNTIME_EXCEPTION : Status Message: bad allocation")
        self.calls = []

    def infer(self, text, voice=None):
        self.calls.append(text)
        if len(text) > self.limit:
            raise self.error
        return [ord(c) for c in text]


def run_safe(tts, text):
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        try:
            return tts_runner.infer_safe(tts, text, "v"), err.getvalue(), None
        except Exception as e:  # noqa: BLE001
            return None, err.getvalue(), e


TEXT_150 = " ".join(["từng"] * 30) + "x"  # 150 ký tự, khoảng trắng mỗi 5 ký tự


class InferSafeTest(unittest.TestCase):
    def test_tc71_splits_on_bad_allocation(self):
        self.assertEqual(len(TEXT_150), 150)
        pieces, log, err = run_safe(FakeTts(60), TEXT_150)
        self.assertIsNone(err)
        audio = [x for p in pieces for x in p]
        self.assertNotIn(0, audio)  # không chèn khoảng lặng giữa các nửa
        self.assertEqual("".join(chr(x) for x in audio).split(), TEXT_150.split())  # đúng thứ tự, không mất chữ
        self.assertIn("[tts] thiếu bộ nhớ ở đoạn 150 ký tự, chia đôi", log)

    def test_tc72_other_error_reraised_once(self):
        tts = FakeTts(0, ValueError("voice"))
        _, log, err = run_safe(tts, TEXT_150)
        self.assertIsInstance(err, ValueError)
        self.assertEqual(len(tts.calls), 1)
        self.assertNotIn("chia đôi", log)

    def test_tc73_always_failing_stops_below_min(self):
        for error in (RuntimeError("BAD ALLOCATION"), MemoryError()):
            tts = FakeTts(-1, error)
            _, log, err = run_safe(tts, TEXT_150)
            self.assertIs(err, error)
            self.assertLessEqual(len(tts.calls), 16)
            self.assertTrue(all(len(t) >= 40 for t in tts.calls[:-1]))
            self.assertLess(len(tts.calls[-1]), 40)
            self.assertIn("chia đôi", log)

    def test_tc74_split_point(self):
        self.assertEqual(tts_runner.split_half("aa bbbb cc dd"), ("aa bbbb", "cc dd"))
        left, right = tts_runner.split_half(TEXT_150)
        self.assertEqual(left + " " + right, TEXT_150)
        self.assertEqual(tts_runner.split_half("x" * 41), ("x" * 20, "x" * 21))
        tts = FakeTts(-1)
        run_safe(tts, "x" * 40)
        self.assertEqual(len(tts.calls), 2)
        tts = FakeTts(-1)
        run_safe(tts, "x" * 39)
        self.assertEqual(len(tts.calls), 1)


LONG = "một hai ba, " * 30 + "hết."  # 364 ký tự, > MAX_CHUNK


class ChunksTest(unittest.TestCase):
    """PMO #92: phần cắt tiếp của cùng một câu dài không phải đầu câu."""

    def test_long_sentence_parts_are_not_sentence_starts(self):
        parts = list(tts_runner.chunks(LONG + "\nCâu sau."))
        self.assertTrue(len(parts) > 2)
        self.assertTrue(all(len(p) <= tts_runner.MAX_CHUNK for p, _ in parts))
        self.assertEqual([s for _, s in parts], [True] + [False] * (len(parts) - 2) + [True])
        self.assertEqual(parts[-1], ("Câu sau.", True))

    def test_line_breaks_do_not_split_sentence(self):
        self.assertEqual(list(tts_runner.chunks("trường\nhọc tốt. Hết")), [("trường học tốt.", True), ("Hết", True)])


FAKE_NP = types.SimpleNamespace(
    float32="float32",
    zeros=lambda n, dtype=None: [0] * n,
    asarray=lambda w, dtype=None: list(w),
    concatenate=lambda pieces: [x for p in pieces for x in p],
)


class SynthesizeOneTest(unittest.TestCase):
    """PMO #92 (TC-71g): khoảng lặng chỉ chèn giữa hai câu, không chèn giữa các phần của cùng một câu."""

    def test_silence_only_between_sentences(self):
        text = LONG + "\nCâu sau. Câu cuối."
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "c.txt")
            with open(src, "w", encoding="utf-8") as f:
                f.write(text)
            tts = FakeTts(10 ** 6)
            saved = []
            tts.save = lambda audio, wav: saved.append(audio)
            with mock.patch.dict(sys.modules, {"numpy": FAKE_NP}), \
                    mock.patch.object(tts_runner.subprocess, "run") as run, contextlib.redirect_stderr(io.StringIO()):
                tts_runner.synthesize_one(tts, src, os.path.join(d, "c.mp3"), "v", "v3nano", 1.0, 10, "64k", "ffmpeg")
        audio = saved[0]
        silences = [len(list(g)) for k, g in itertools.groupby(audio, key=lambda x: x == 0) if k]
        self.assertEqual(silences, [240, 240])  # 24 kHz × 10 ms, chỉ trước "Câu sau." và "Câu cuối."
        parts = list(tts_runner.chunks(text))
        self.assertGreater(len(parts), 3)  # câu dài bị cắt thành nhiều phần
        self.assertEqual("".join(chr(x) for x in audio if x), "".join(p for p, _ in parts))
        run.assert_called_once()


if __name__ == "__main__":
    unittest.main()
