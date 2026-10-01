# -*- coding: utf-8 -*-
"""Имена и термины на слух -> как в источнике; нечёткое сопоставление с источником."""
import unittest

from phase1_ingest.source_text import assign_source_words
from phase2_tools.retext_from_source import fix_terms, known_words, proper_nouns

SOURCE = [
    ("Yangyang", "This is the statue of Jue, the Sentinel (Oracle Engine) in Jinzhou, in the shape of a Loong (dragon)."),
    ("Chixia", "Isn't that Baizhi?! We made it through all those Tacet Discord outbreaks."),
    ("Yangyang", "Because of its long history and vast land, the Tacet Field is safe."),
    ("Chixia", "United we stand."),
]


class TestFixTerms(unittest.TestCase):
    def setUp(self):
        self.terms = proper_nouns(SOURCE)
        self.known = known_words(SOURCE)

    def fix(self, text):
        return fix_terms(text, self.terms, self.known)

    def test_names(self):
        self.assertEqual(self.fix("Baija!"), "Baizhi!")
        self.assertEqual(self.fix("when Jinjo didn't exist"), "when Jinzhou didn't exist")
        self.assertEqual(self.fix("Yang Yang! Wait"), "Yangyang! Wait")

    def test_common_words_untouched(self):
        # "long" в источнике есть обычным словом — не превращается в Loong.
        self.assertEqual(self.fix("a long time"), "a long time")
        # Строчное слово без термина рядом не трогается.
        self.assertEqual(self.fix("they resonated"), "they resonated")
        # Междометия короче 5 букв не трогаются.
        self.assertEqual(self.fix("Hiya!"), "Hiya!")

    def test_lowercase_next_to_term(self):
        self.assertEqual(self.fix("the tacit discord outbreaks"), "the Tacet Discord outbreaks")


class TestFuzzySource(unittest.TestCase):
    def test_misheard_names_take_source_text(self):
        heard = "This is the statue of Zhe, the sentinel in Zhengzhou, in the shape of a long."
        asr_words = [{"id": f"w{i}", "word": w} for i, w in enumerate(heard.split())]
        source_words = [{"word": w, "newline_before": i == 0, "speaker": "Yangyang"}
                        for i, w in enumerate(SOURCE[0][1].split())]
        entries = [{"source_segment_ids": [w["id"] for w in asr_words], "text": heard}]
        assign_source_words(entries, asr_words, source_words)
        self.assertEqual(entries[0]["text"], "Yangyang: " + SOURCE[0][1])


class TestHeardRanges(unittest.TestCase):
    def test_missing_heard_words(self):
        from phase2_tools.retext_from_source import missing_words

        source = [("Yangyang", "Jinzhou sits right between the Desorock Highland and the Norfall Barrens."),
                  ("Chixia", "Welcome to Jinzhou!")]
        terms, known = proper_nouns(source), known_words(source)

        def heard(text):
            return [{"word": w} for w in text.split()]

        # Пропавшее начало фразы (порядок слов в озвучке другой) — вставляется.
        found = missing_words("Yangyang: between the Desorock Highland and the Norfall Barrens.",
                              heard("Jinjo sits between the Desert Highland and the Norful Barrens."), terms, known)
        self.assertEqual(found, [(10, "Jinzhou sits", True)])
        # Слово, разбитое распознаванием на части, — не пропуск.
        self.assertEqual(missing_words("Chixia: Are you alright?", heard("Are you all right?"), terms, known), [])
        # Другая формулировка — не пропуск.
        self.assertEqual(missing_words("Yangyang: It is a border city as well as fortress.",
                                       heard("It's a border city and a fortress."), terms, known), [])

    def test_lines_not_in_source_are_heard(self):
        from phase2_tools.retext_from_source import heard_ranges, source_index

        text = "Chixia: Isn't that Baizhi?!\nYangyang: My apologies, it is temporarily safe."
        ranges = heard_ranges(text, source_index(SOURCE))
        self.assertEqual([text[a:b] for a, b in ranges], ["Yangyang: My apologies, it is temporarily safe."])

    def test_carry_and_shift(self):
        from common.manifest_schema import carry_ranges, shift_ranges

        # Исправленное слово теряет отметку, остальное остаётся голубым.
        old, new = "Hiya Baija!", "Hiya Baizhi!"
        carried = carry_ranges(old, new, [[0, len(old)]])
        marked = "".join(new[a:b] for a, b in carried)
        self.assertTrue(marked.startswith("Hiya Bai"))
        self.assertNotIn("zh", marked)
        self.assertEqual(shift_ranges([[0, 3]], 10), [[10, 13]])


if __name__ == "__main__":
    unittest.main()
