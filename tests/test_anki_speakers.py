# -*- coding: utf-8 -*-
"""Имена говорящих при записи в Anki: из текста — в метки, реплики одного персонажа — одной строкой."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from phase3_export.anki import note_tags, split_speakers

KNOWN = {"Yangyang", "Chixia", "Rover", "Elder Exile"}


class TestSplitSpeakers(unittest.TestCase):
    def test_same_speaker_repeated_in_one_line(self):
        text = ("Yangyang: No visible signs of trauma.\n"
                "Yangyang: So you don't know. Yangyang: Breathing seems ... normal.\n"
                "Yangyang: Heart rate ... should be fast ...\nI think")
        clean, speakers = split_speakers(text, KNOWN)
        self.assertEqual(clean, "No visible signs of trauma. So you don't know. Breathing seems ... normal. "
                                "Heart rate ... should be fast ... I think")
        self.assertEqual(speakers, ["Yangyang"])

    def test_new_speaker_starts_new_line(self):
        text = "Yangyang: I think. … You're awake!\nChixia: Let me see! Let me see!"
        clean, speakers = split_speakers(text, KNOWN)
        self.assertEqual(clean, "I think. … You're awake!\nLet me see! Let me see!")
        self.assertEqual(speakers, ["Yangyang", "Chixia"])

    def test_colon_in_text_is_not_a_speaker(self):
        clean, speakers = split_speakers("Chixia: Emergency Skills, Lesson One: CPR!", KNOWN)
        self.assertEqual((clean, speakers), ("Emergency Skills, Lesson One: CPR!", ["Chixia"]))

    def test_tags_have_no_spaces(self):
        self.assertIn("Elder_Exile", note_tags("p", "frag_0001", ["Elder Exile"]))


if __name__ == "__main__":
    unittest.main()
