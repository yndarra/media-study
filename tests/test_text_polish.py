# -*- coding: utf-8 -*-
"""Оформление строк карточек: заглавные, точка в конце, парные кавычки."""
import unittest

from common.text_polish import polish_line, polish_text


class TestPolish(unittest.TestCase):
    def test_capitals(self):
        self.assertEqual(polish_line("with me. and that strange thing is here."), "With me. And that strange thing is here.")
        # После многоточия и сокращений — без заглавной.
        self.assertEqual(polish_line("And... that strange thing."), "And... that strange thing.")
        self.assertEqual(polish_line("Ask Mr. zongye."), "Ask Mr. zongye.")

    def test_sentence_end(self):
        self.assertEqual(polish_line("uncannily powerful Tacet Discords, and now,"), "Uncannily powerful Tacet Discords, and now.")
        self.assertEqual(polish_line("that story"), "That story.")
        self.assertEqual(polish_line("Is it you?"), "Is it you?")
        self.assertEqual(polish_line("I was going to—"), "I was going to—")
        self.assertEqual(polish_line("Wait..."), "Wait...")

    def test_quotes(self):
        self.assertEqual(polish_line('The Sentinel is known as "Juè, manifesting'), 'The Sentinel is known as "Juè, manifesting."')
        self.assertEqual(polish_line('like the statue you just saw."'), '"Like the statue you just saw."')
        self.assertEqual(polish_line("“I'm back. I'm back!"), "“I'm back. I'm back!”")
        self.assertEqual(polish_line("the Rangers' base, don't go"), "The Rangers' base, don't go.")
        self.assertEqual(polish_line("‘Hero Plays"), "‘Hero Plays.’")

    def test_speaker_lines(self):
        self.assertEqual(polish_text("Chixia: never actually been safe here,\nYangyang: right"),
                         "Chixia: Never actually been safe here.\nYangyang: Right.")
        self.assertEqual(polish_text("Chixia: ..."), "Chixia: ...")

    def test_one_speaker_several_lines_is_one_sentence(self):
        self.assertEqual(polish_text("Chixia: Whether it's true or not, that story\nChixia: happened long ago"),
                         "Chixia: Whether it's true or not, that story\nChixia: happened long ago.")

    def test_dialect_apostrophes_are_not_quotes(self):
        for line in ("Oh, I also tried searchin’ for Rover’s terminal.", "Sorry, I'm chattin' up a storm...",
                     "There should be some Roseshrooms 'round here.", "You been playin' the fool all along?"):
            self.assertEqual(polish_line(line), line)

    def test_continuation_start_kept(self):
        self.assertEqual(polish_line("– while I couldn't feel a thing, haha."), "– while I couldn't feel a thing, haha.")


if __name__ == "__main__":
    unittest.main()
