# -*- coding: utf-8 -*-
"""Юнит-тесты сегментации: полное покрытие, паузы, короткие обрывки, контекст ±60 с."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from phase1_ingest import segment
from common.context_bounds import CONTEXT_PADDING_SECONDS
from common.frame_time import frames_for_seconds
from common.manifest_schema import validate_full_coverage


FPS = 30.0
TOTAL_FRAMES = 6000  # 200 секунд


def make_words():
    return [
        {"start": 10.0, "end": 10.3, "word": "hello"},
        {"start": 10.3, "end": 10.6, "word": "there"},
        # длинная пауза -> отдельный filler
        {"start": 15.0, "end": 15.4, "word": "general"},
        {"start": 15.4, "end": 15.9, "word": "kenobi"},
        {"start": 15.95, "end": 16.2, "word": "again"},
    ]


def build(words):
    words = [{"id": f"w{i:03d}", **w} for i, w in enumerate(words)]
    raw = segment.merge_glitches(segment.derive_raw_segments_from_words(words))
    entries = segment.fill_full_coverage(raw, FPS, TOTAL_FRAMES)
    return segment.build_fragments(entries, FPS, TOTAL_FRAMES)


class TestFullCoverage(unittest.TestCase):
    def test_partition_has_no_gaps_or_overlaps(self):
        fragments = build(make_words())
        validate_full_coverage(fragments, TOTAL_FRAMES)
        for previous, current in zip(fragments, fragments[1:]):
            self.assertEqual(previous.algo_end_frame, current.algo_start_frame)

    def test_long_silences_become_fillers_with_edge_padding(self):
        fragments = build(make_words())
        kinds = [f.kind for f in fragments]
        self.assertEqual(kinds, ["filler", "phrase", "filler", "phrase", "filler"])
        pad = frames_for_seconds(segment.EDGE_PAD_SECONDS, FPS)
        first_phrase = fragments[1]
        # Фраза начинается чуть раньше первого слова — запас, чтобы не резать звук.
        self.assertEqual(first_phrase.algo_start_frame, frames_for_seconds(10.0, FPS) - pad)

    def test_short_gap_is_split_between_neighbors_not_a_filler(self):
        raw = [
            {"start": 10.0, "end": 10.5, "text": "first phrase", "source_segment_ids": []},
            {"start": 10.9, "end": 11.5, "text": "second phrase", "source_segment_ids": []},
        ]
        entries = segment.fill_full_coverage(raw, FPS, TOTAL_FRAMES)
        phrases = [e for e in entries if e["text"]]
        self.assertEqual(len([e for e in entries if not e["text"]]), 2)  # только начало и конец видео
        middle = (frames_for_seconds(10.5, FPS) + frames_for_seconds(10.9, FPS)) // 2
        self.assertEqual(phrases[0]["end_frame"], middle)
        self.assertEqual(phrases[1]["start_frame"], middle)

    def test_no_tiny_fillers(self):
        # Пауза 1.2 с: после запасов по краям тишины остаётся меньше 1 с —
        # отдельного фрагмента из нескольких кадров быть не должно.
        raw = [
            {"start": 10.0, "end": 11.0, "text": "a", "source_segment_ids": []},
            {"start": 12.2, "end": 13.0, "text": "b", "source_segment_ids": []},
        ]
        entries = segment.fill_full_coverage(raw, FPS, TOTAL_FRAMES)
        min_filler = frames_for_seconds(segment.MIN_FILLER_SECONDS, FPS)
        for entry in entries:
            if not entry["text"]:
                self.assertGreaterEqual(entry["end_frame"] - entry["start_frame"], min_filler)

    def test_real_short_reply_stays_separate(self):
        segments = [
            {"start": 10.0, "end": 12.0, "text": "long one", "source_segment_ids": ["a"]},
            {"start": 12.4, "end": 12.8, "text": "Yes.", "source_segment_ids": ["b"]},
            {"start": 13.2, "end": 15.0, "text": "another long", "source_segment_ids": ["c"]},
        ]
        self.assertEqual(len(segment.merge_glitches(segments)), 3)

    def test_timestamp_glitch_is_merged_into_closest_neighbor(self):
        segments = [
            {"start": 10.0, "end": 12.0, "text": "long one", "source_segment_ids": ["a"]},
            {"start": 12.1, "end": 12.15, "text": "uh", "source_segment_ids": ["b"]},
            {"start": 12.9, "end": 15.0, "text": "another long", "source_segment_ids": ["c"]},
        ]
        merged = segment.merge_glitches(segments)
        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0]["source_segment_ids"], ["a", "b"])

    def test_isolated_glitch_is_widened_not_left_as_few_frames(self):
        segments = [
            {"start": 10.0, "end": 12.0, "text": "long one", "source_segment_ids": ["a"]},
            {"start": 20.0, "end": 20.0, "text": "hm", "source_segment_ids": ["b"]},
            {"start": 30.0, "end": 32.0, "text": "another long", "source_segment_ids": ["c"]},
        ]
        merged = segment.merge_glitches(segments)
        self.assertEqual(len(merged), 3)
        self.assertAlmostEqual(merged[1]["end"] - merged[1]["start"], segment.GLITCH_MIN_WIDTH_SECONDS)

    def test_sentence_end_splits_long_enough_phrase(self):
        words = [
            {"start": 1.0, "end": 1.5, "word": "This"},
            {"start": 1.5, "end": 2.0, "word": "is"},
            {"start": 2.0, "end": 3.6, "word": "done."},
            {"start": 3.7, "end": 4.2, "word": "Next"},
            {"start": 4.2, "end": 4.8, "word": "one."},
        ]
        words = [{"id": f"w{i}", **w} for i, w in enumerate(words)]
        raw = segment.derive_raw_segments_from_words(words)
        self.assertEqual([r["text"] for r in raw], ["This is done.", "Next one."])

    def test_chained_overlaps_do_not_produce_degenerate_zero_length_fragment(self):
        raw = [
            {"start": 10.00, "end": 10.60, "text": "first", "source_segment_ids": []},
            {"start": 10.55, "end": 10.65, "text": "middle", "source_segment_ids": []},
            {"start": 10.58, "end": 11.20, "text": "third", "source_segment_ids": []},
        ]
        entries = segment.fill_full_coverage(raw, FPS, TOTAL_FRAMES)
        fragments = segment.build_fragments(entries, FPS, TOTAL_FRAMES)
        validate_full_coverage(fragments, TOTAL_FRAMES)
        for fragment in fragments:
            self.assertLess(fragment.algo_start_frame, fragment.algo_end_frame)

    def test_context_is_exactly_one_minute_each_side_away_from_video_edges(self):
        fps = 30.0
        total = frames_for_seconds(600, fps)  # 10 минут
        raw = [{"start": 300.0, "end": 303.0, "text": "middle of video", "source_segment_ids": []}]
        entries = segment.fill_full_coverage(raw, fps, total)
        fragments = segment.build_fragments(entries, fps, total)
        phrase = next(f for f in fragments if f.kind == "phrase")
        pad = frames_for_seconds(CONTEXT_PADDING_SECONDS, fps)
        self.assertEqual(phrase.algo_start_frame - phrase.context_start_frame, pad)
        self.assertEqual(phrase.context_end_frame - phrase.algo_end_frame, pad)

    def test_context_clipped_only_by_video_edges(self):
        fragments = build(make_words())
        self.assertEqual(fragments[0].context_start_frame, 0)
        self.assertEqual(fragments[-1].context_end_frame, TOTAL_FRAMES)


if __name__ == "__main__":
    unittest.main()
