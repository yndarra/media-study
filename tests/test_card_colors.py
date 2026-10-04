# -*- coding: utf-8 -*-
"""Цвета на карточках Anki и строка говорящих (media_study/export/anki.py, decorate)."""
import unittest

from media_study.export import anki

C = {"en": "#e", "ru": "#r", "dash": "#d", "who": "#w"}


class TestDecorate(unittest.TestCase):
    def test_translated_card_names_at_end_of_back(self):
        front, back = anki.decorate("[sound:a.mp4]<br>Hi.", "Привет.<br><br><i>hi</i> – привет", ["Rover"], C)
        self.assertIn('<span class="ms-en" style="color:#e">Hi.</span>', front)
        self.assertIn('<span class="ms-dash" style="color:#d">–</span>', back)
        self.assertTrue(back.endswith('<div class="ms-who" style="color:#w">Rover</div>'))
        self.assertNotIn("ms-who", front)

    def test_untranslated_card_keeps_back_empty(self):
        front, back = anki.decorate("[sound:a.mp4]<br>Hi.", "", ["Rover"], C)
        self.assertEqual(back, "")
        self.assertIn("ms-who", front)
        self.assertEqual(anki.plain_front(front), "Hi.")

    def test_repaint_is_stable_and_recolors(self):
        front, back = anki.decorate("[sound:a.mp4]<br>Hi.", "Привет.", ["A"], C)
        self.assertEqual(anki.decorate(front, back, None, C), (front, back))
        _, back2 = anki.decorate(front, back, None, {**C, "ru": "#new"})
        self.assertIn("#new", back2)
        self.assertNotIn('color:#r"', back2)


if __name__ == "__main__":
    unittest.main()
