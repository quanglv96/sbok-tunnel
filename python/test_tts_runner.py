"""PMO #92: không chèn khoảng lặng giữa các phần cắt của cùng một câu dài. Chạy: python -m unittest discover python"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from tts_runner import MAX_CHUNK, chunks  # noqa: E402


class ChunksTest(unittest.TestCase):
    def test_long_sentence_parts_are_not_sentence_starts(self):
        long = "một hai ba, " * 30 + "hết."
        parts = list(chunks(long + "\nCâu sau."))
        self.assertTrue(len(parts) > 2)
        self.assertTrue(all(len(p) <= MAX_CHUNK for p, _ in parts))
        self.assertEqual([s for _, s in parts], [True] + [False] * (len(parts) - 2) + [True])
        self.assertEqual(parts[-1], ("Câu sau.", True))

    def test_line_breaks_do_not_split_sentence(self):
        self.assertEqual(list(chunks("trường\nhọc tốt. Hết")), [("trường học tốt.", True), ("Hết", True)])


if __name__ == "__main__":
    unittest.main()
