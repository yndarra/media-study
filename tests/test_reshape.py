# -*- coding: utf-8 -*-
"""Доводка нарезки: деление по говорящим и склейка фраз, оборванных на запятой."""
import unittest

from media_study.ingest import reshape
from media_study.ingest.source_text import _join

FPS = 10.0


def word(text, speaker, newline=False):
    return {"word": text, "speaker": speaker, "newline_before": newline}


class TestSplit(unittest.TestCase):
    def test_two_speakers_split_at_reply(self):
        asr = [{"id": f"w{i}", "word": "x", "start": i * 0.5, "end": i * 0.5 + 0.4} for i in range(8)]
        words = [(word("Here,", "Suisui", True), 0), (word("take", "Suisui"), 1), (word("this.", "Suisui"), 2),
                 (word("What's", "Rover", True), 5), (word("this?", "Rover"), 6)]
        entry = {"start_frame": 0, "end_frame": 40, "text": "Suisui: Here, take this.\nRover: What's this?",
                 "source_segment_ids": [f"w{i}" for i in range(8)], "_words": words}
        parts = reshape.split_by_speakers([entry], asr, FPS, _join)
        self.assertEqual([p["text"] for p in parts], ["Suisui: Here, take this.", "Rover: What's this?"])
        self.assertEqual((parts[0]["start_frame"], parts[0]["end_frame"], parts[1]["end_frame"]), (0, 25, 40))

    def test_one_speaker_not_split(self):
        entry = {"start_frame": 0, "end_frame": 40, "text": "Suisui: Hi.\nSuisui: Bye.",
                 "_words": [(word("Hi.", "Suisui", True), 0), (word("Bye.", "Suisui", True), 1)]}
        self.assertEqual(len(reshape.split_by_speakers([entry], [{"id": "w0", "start": 0}, {"id": "w1", "start": 1}], FPS, _join)), 1)


class TestMergeComma(unittest.TestCase):
    def test_comma_tail_joined_lowercase(self):
        entries = [{"start_frame": 0, "end_frame": 20, "text": "Suisui: When we got there,", "source_segment_ids": ["a"]},
                   {"start_frame": 20, "end_frame": 40, "text": "Suisui: The gate was open.", "source_segment_ids": ["b"]}]
        out = reshape.merge_comma_tails(entries, FPS, {"I"})
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["text"], "Suisui: When we got there, the gate was open.")
        self.assertEqual(out[0]["end_frame"], 40)

    def test_names_keep_capital_and_other_speaker_not_joined(self):
        entries = [{"start_frame": 0, "end_frame": 20, "text": "Suisui: Look,"},
                   {"start_frame": 20, "end_frame": 40, "text": "Rover is here."}]
        out = reshape.merge_comma_tails(entries, FPS, {"I", "Rover"})
        self.assertEqual(out[0]["text"], "Suisui: Look, Rover is here.")
        entries = [{"start_frame": 0, "end_frame": 20, "text": "Suisui: Look,"},
                   {"start_frame": 20, "end_frame": 40, "text": "Rover: What?"}]
        self.assertEqual(len(reshape.merge_comma_tails(entries, FPS, set())), 2)


class TestMergeClose(unittest.TestCase):
    # Слова распознавания: w0..w3 – первая фраза, w4..w7 – вторая.
    @staticmethod
    def asr(gap):
        first = [{"id": f"w{i}", "start": i * 0.3, "end": i * 0.3 + 0.25} for i in range(4)]
        second = [{"id": f"w{i}", "start": first[-1]["end"] + gap + (i - 4) * 0.3, "end": first[-1]["end"] + gap + (i - 4) * 0.3 + 0.25}
                  for i in range(4, 8)]
        return first + second

    @staticmethod
    def entries(first, second):
        return [{"start_frame": 0, "end_frame": 12, "text": first, "source_segment_ids": ["w0", "w1", "w2", "w3"]},
                {"start_frame": 12, "end_frame": 25, "text": second, "source_segment_ids": ["w4", "w5", "w6", "w7"]}]

    def test_same_speaker_no_pause_joined(self):
        out = reshape.merge_close_phrases(self.entries("Suisui: Wait.", "Suisui: Where are you going?"), self.asr(0.1), FPS)
        self.assertEqual([e["text"] for e in out], ["Suisui: Wait. Where are you going?"])
        self.assertEqual((out[0]["start_frame"], out[0]["end_frame"]), (0, 25))

    def test_pause_or_other_speaker_not_joined(self):
        self.assertEqual(len(reshape.merge_close_phrases(self.entries("Suisui: Wait.", "Suisui: Where?"), self.asr(0.8), FPS)), 2)
        self.assertEqual(len(reshape.merge_close_phrases(self.entries("Suisui: Wait.", "Rover: Where?"), self.asr(0.1), FPS)), 2)
        self.assertEqual(len(reshape.merge_close_phrases(self.entries("Suisui: Wait.", "Where?"), self.asr(0.1), FPS)), 2)

    def test_no_names_and_too_long(self):
        self.assertEqual(len(reshape.merge_close_phrases(self.entries("Wait.", "Where?"), self.asr(0.1), FPS)), 1)
        long_text = "Suisui: " + "word " * 30
        self.assertEqual(len(reshape.merge_close_phrases(self.entries("Suisui: Wait.", long_text), self.asr(0.1), FPS)), 2)


if __name__ == "__main__":
    unittest.main()
