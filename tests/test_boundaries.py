# -*- coding: utf-8 -*-
"""Выбор границ фраз: смысловые разрезы вместо "до первого лимита" (без модели)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from media_study.ingest import boundaries as bnd


def stream(text: str, word_seconds: float = 0.3, pauses: dict | None = None) -> list[dict]:
    """Слова подряд без пауз (как быстрая речь у Whisper); pauses: {индекс: пауза после слова}."""
    words, t = [], 0.0
    for index, word in enumerate(text.split()):
        words.append({"id": f"w{index:05d}", "word": word, "start": t, "end": t + word_seconds})
        t += word_seconds + (pauses or {}).get(index, 0.0)
    return words


def source(text: str) -> list[dict]:
    result = []
    for line in text.split("\n"):
        for index, word in enumerate(line.split()):
            result.append({"word": word, "newline_before": index == 0})
    return result


class TestChooseSegments(unittest.TestCase):
    def test_sentence_is_not_cut_in_the_middle(self):
        # Пример пользователя: Whisper без точек и пауз, субтитры с пунктуацией.
        asr = stream(
            "and now we have some good tasting electrolytes after hours of struggling we were only 10 % "
            "of the way to our helicopter desert was at 11 % and antarctic was still at 7 %"
        )
        subs = source(
            "And now we have some\ngood-tasting electrolytes.\nAfter hours of struggling, we were\n"
            "only 10% of the way\nto our helicopter.\nDesert was at 11%,\nand Antarctic was still at 7%."
        )
        segments = bnd.segment_words(asr, subs, use_model=False)
        texts = [s["text"] for s in segments]
        self.assertTrue(any(t.endswith("way to our helicopter") for t in texts), texts)
        for t in texts:
            self.assertNotIn(t.split()[-1], {"the", "of", "to", "our"}, texts)

    def test_long_pause_always_splits(self):
        asr = stream("hello there my friend how are you", pauses={3: 1.5})
        segments = bnd.segment_words(asr, [], use_model=False)
        self.assertEqual([s["text"] for s in segments][0].split()[-1], "friend")

    def test_source_comma_attaches_to_percent_sign(self):
        asr = stream("desert was at 11 % and antarctic")
        probs = bnd.source_boundary_probs(asr, source("Desert was at 11%, and Antarctic"))
        self.assertGreater(probs[4], probs[3])  # после "%", а не после "11"


if __name__ == "__main__":
    unittest.main()
