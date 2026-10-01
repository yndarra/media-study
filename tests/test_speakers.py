# -*- coding: utf-8 -*-
"""Реплики персонажей: имя говорящего сохраняется, лишний текст источника отбрасывается, Rover — он."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from phase1_ingest import source_text
from phase1_ingest.sources.notion import dialogue_line


def asr(text: str) -> list[dict]:
    return [{"id": f"w{i:05d}", "word": w, "start": i * 0.3, "end": i * 0.3 + 0.25} for i, w in enumerate(text.split())]


def transcript(lines: str) -> list[dict]:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "t.txt"
        path.write_text(lines, encoding="utf-8")
        return source_text.words_from_transcript(path)


class TestSpeakers(unittest.TestCase):
    def test_dialogue_line_parsing(self):
        self.assertEqual(dialogue_line('Yangyang: "...Chixia."'), ("Yangyang", "...Chixia."))
        self.assertEqual(dialogue_line('Rover:  ”I believe so.”'), ("Rover", "I believe so."))
        self.assertIsNone(dialogue_line("note: this is lowercase"))

    def test_speaker_name_starts_each_line_even_mid_reply(self):
        words = asr("where am i we are in the gorges of spirits")
        src = transcript('Rover: "Where am I?"\nYangyang: "We are in the Gorges of Spirits."\n')
        entries = [
            {"source_segment_ids": [w["id"] for w in words[:6]]},  # ...we are in
            {"source_segment_ids": [w["id"] for w in words[6:]]},  # the gorges of spirits
        ]
        source_text.assign_source_words(entries, words, src)
        self.assertEqual(entries[0]["text"], "Rover: Where am I?\nYangyang: We are in")
        self.assertEqual(entries[1]["text"], "Yangyang: the Gorges of Spirits.")

    def test_extra_source_text_is_dropped(self):
        words = asr("hello there friend how are you")
        src = transcript("A: Hello there friend.\nB: This whole long side dialogue was never chosen in the video at all.\nA: How are you?\n")
        kept = source_text.trim_extra_source(words, src)
        self.assertEqual([w["word"] for w in kept], ["Hello", "there", "friend.", "How", "are", "you?"])
        self.assertTrue(kept[3]["newline_before"])

    def test_rover_is_he_when_heard_so(self):
        words = asr("he said she would come")
        src = transcript("Chixia: She said she would come.\n")
        entries = [{"source_segment_ids": [w["id"] for w in words]}]
        source_text.assign_source_words(entries, words, src)
        self.assertEqual(entries[0]["text"], "Chixia: He said she would come.")


if __name__ == "__main__":
    unittest.main()
