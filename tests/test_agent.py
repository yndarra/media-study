# -*- coding: utf-8 -*-
"""Агент перевода: оборот строго по правилам и комментарии со звёздочкой."""
import unittest

from phase3_export.agent import extract_comments, front_text, render_back


class TestRenderBack(unittest.TestCase):
    def test_only_translation(self):
        self.assertEqual(render_back({"translation": "Это что, собрание телепатов?"}), "Это что, собрание телепатов?")

    def test_all_parts_in_order_with_blank_lines(self):
        back = render_back({
            "translation": "Это что, собрание телепатов?",
            "alternatives": ["Тут что, сходка телепатов?"],
            "terms": [{"phrase": "mind-reading", "meaning": "чтение мыслей — телепатия"}],
            "literal": "Это что, собрание по чтению мыслей?",
            "explanation": "Rover шутит.",
        })
        self.assertEqual(
            back,
            "Это что, собрание телепатов?<ul><li>Тут что, сходка телепатов?</li></ul>"
            "<br><i>mind-reading</i> – чтение мыслей – телепатия"
            "<br><br>Это что, собрание по чтению мыслей? – буквальный перевод"
            "<br><br>Rover шутит.",
        )
        self.assertNotIn("—", back)

    def test_multiline_translation(self):
        self.assertEqual(render_back({"translation": "Привет.\nПока."}), "Привет.<br>Пока.")


class TestComments(unittest.TestCase):
    def test_comment_line_removed(self):
        front = "[sound:x.mp4]<br>Is this a mind-reading gathering?<br>*поясни за слово gathering"
        cleaned, comments = extract_comments(front)
        self.assertEqual(cleaned, "[sound:x.mp4]<br>Is this a mind-reading gathering?")
        self.assertEqual(comments, ["поясни за слово gathering"])
        self.assertEqual(front_text(cleaned), "Is this a mind-reading gathering?")

    def test_inline_comment(self):
        cleaned, comments = extract_comments("Это собрание. *почему не встреча?")
        self.assertEqual((cleaned, comments), ("Это собрание.", ["почему не встреча?"]))

    def test_no_comments(self):
        self.assertEqual(extract_comments("Привет<br>Пока"), ("Привет<br>Пока", []))


if __name__ == "__main__":
    unittest.main()
