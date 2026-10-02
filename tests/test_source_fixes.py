# -*- coding: utf-8 -*-
"""Разбор реплик вики ("???", шаблон Ровера) и страховки ИИ-доводки."""
import unittest

from phase1_ingest.ai_fix import _close_enough, _drop_new_speakers
from phase1_ingest.sources import notion, search_agent


class TestDialogue(unittest.TestCase):
    def test_unknown_speaker_kept(self):
        self.assertEqual(notion.dialogue_line("???: So, when will you finally consider it?"),
                         ("???", "So, when will you finally consider it?"))

    def test_rover_template_line_parsed(self):
        line = "(‍RoverThe player's chosen name for Rover‍): Fogveil Pagoda, where Hsin's frequency appeared."
        self.assertEqual(search_agent._dialogue([line]), ["Rover: Fogveil Pagoda, where Hsin's frequency appeared."])

    def test_lowercase_text_with_colon_rejected(self):
        self.assertIsNone(notion.dialogue_line("note: this is not a line"))


class TestAiFixGuards(unittest.TestCase):
    def test_new_speaker_dropped_existing_kept(self):
        self.assertEqual(_drop_new_speakers("We found it.", "Rover: We found it."), "We found it.")
        self.assertEqual(_drop_new_speakers("Abby: hi", "Abby: hi!"), "Abby: hi!")

    def test_rewrite_rejected(self):
        self.assertTrue(_close_enough("We found this inside Fogveld pagoda.", "We found this inside Fogveil Pagoda."))
        self.assertFalse(_close_enough("Let's go.", "The weather is lovely in Jinzhou today."))


if __name__ == "__main__":
    unittest.main()
