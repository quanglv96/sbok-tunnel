"""Unit test disable_codec_arena với engine/onnxruntime giả (chạy: python -I python/test_tts_runner.py)."""
import os
import sys
import unittest

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


if __name__ == "__main__":
    unittest.main()
