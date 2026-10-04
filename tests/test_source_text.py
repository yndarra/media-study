# -*- coding: utf-8 -*-
"""
Пословная раскладка текста источника по фрагментам: без повторов между
соседними фрагментами, с сохранением переносов строк, с устойчивостью к
"накопительным" репликам субтитров YouTube.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from media_study.ingest.source_text import assign_source_words, words_from_cues


def asr(*words):
    return [{"id": f"w{i}", "word": w} for i, w in enumerate(words)]


class TestWordsFromCues(unittest.TestCase):
    def test_rollup_and_scrolling_cues_do_not_duplicate_words(self):
        cues = [
            {"start": 0.0, "end": 1.0, "text": "one two"},
            {"start": 0.0, "end": 2.0, "text": "one two three"},
            {"start": 2.0, "end": 3.0, "text": "three\nfour five"},
        ]
        words = words_from_cues(cues)
        self.assertEqual([w["word"] for w in words], ["one", "two", "three", "four", "five"])
        self.assertTrue(words[3]["newline_before"])
        self.assertFalse(words[4]["newline_before"])


class TestAssignSourceWords(unittest.TestCase):
    def setUp(self):
        self.asr_words = asr("hello", "there", "general", "kenobi", "how", "are")
        self.entries = [
            {"text": "hello there", "source_segment_ids": ["w0", "w1"]},
            {"text": "", "source_segment_ids": []},
            {"text": "general kenobi how are", "source_segment_ids": ["w2", "w3", "w4", "w5"]},
        ]

    def test_each_source_word_lands_in_exactly_one_fragment(self):
        source = [
            {"word": "Hello", "newline_before": True},
            {"word": "there!", "newline_before": False},
            {"word": "General", "newline_before": True},
            {"word": "Kenobi,", "newline_before": False},
            {"word": "how", "newline_before": True},
            {"word": "are", "newline_before": False},
        ]
        assign_source_words(self.entries, self.asr_words, source)
        self.assertEqual(self.entries[0]["source_text"], "Hello there!")
        self.assertEqual(self.entries[1]["source_text"], "")
        self.assertEqual(self.entries[2]["source_text"], "General Kenobi,\nhow are")
        # Источнику доверяем — он становится основным текстом.
        self.assertEqual(self.entries[0]["text"], "Hello there!")
        self.assertFalse(self.entries[0].get("needs_review", False))

    def test_line_missing_from_source_stays_heard(self):
        # Реплики нет в источнике, к фрагменту прилипло одно случайное слово
        # соседней строки — текст остаётся распознанным (голубым), а не "ambush".
        source = [{"word": w, "newline_before": False} for w in ["hello", "there", "ambush"]]
        assign_source_words(self.entries, self.asr_words, source)
        self.assertEqual(self.entries[2]["text"], "general kenobi how are")
        self.assertTrue(self.entries[2]["needs_review"])
        self.assertTrue(self.entries[2]["heard"])

    def test_poor_match_keeps_asr_text_and_flags_review(self):
        source = [{"word": w, "newline_before": False} for w in ["completely", "different", "words"]]
        assign_source_words(self.entries, self.asr_words, source)
        self.assertEqual(self.entries[0]["text"], "hello there")
        self.assertTrue(self.entries[0]["needs_review"])


if __name__ == "__main__":
    unittest.main()
