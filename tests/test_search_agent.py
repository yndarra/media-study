# -*- coding: utf-8 -*-
"""Поиск источника: кусок источника, соответствующий видео, и разбор HTML."""
import unittest

from phase1_ingest.sources import search_agent as sa


class TestTrim(unittest.TestCase):
    def test_densest_piece_is_chosen(self):
        other = [f"Elder: unrelated story line number {i} about something else entirely" for i in range(60)]
        ours = [f"Chixia: we are going to the noodle shop number {i} right now" for i in range(30)]
        # Короткая общая фраза из нашего видео встречается и в чужой главе — не должна растянуть кусок.
        lines = other[:20] + ["Yangyang: Are you alright?"] + other[20:] + ours + other[:10]
        heard = sa._pairs(sa._words(" ".join(line.split(": ", 1)[1] for line in ours) + " are you alright"))
        piece, hits = sa.trim_to_video(lines, heard)
        self.assertEqual(hits, 30)
        self.assertNotIn("Yangyang: Are you alright?", piece)
        self.assertIn(ours[0], piece)
        self.assertIn(ours[-1], piece)

    def test_html_dialogue_lines(self):
        parser = sa._TextBlocks()
        parser.feed("<html><script>x=1</script><p>Chixia: Hi there!</p><div>Narration text</div><li>Rover: Hello.</li></html>")
        parser.flush()
        self.assertEqual(sa._dialogue(parser.lines), ["Chixia: Hi there!", "Rover: Hello."])



class TestFillGaps(unittest.TestCase):
    def test_missing_line_comes_from_other_source_in_place(self):
        speech = {"segments": [
            {"start": 1.0, "text": "we are going to the noodle shop right now"},
            {"start": 2.0, "text": "I was worried you just stood there and gazed into the distance"},
            {"start": 3.0, "text": "the noodles here are the best in the whole city"},
        ]}
        main = ["Chixia: We are going to the noodle shop right now!", "Chixia: The noodles here are the best in the whole city."]
        other = ["Elder: Something unrelated about the weather today.",
                 "Yangyang: I was worried... You just stood there and gazed into the distance."]
        lines, added = sa.fill_gaps(main, [other], speech)
        self.assertEqual(added, 1)
        self.assertEqual(lines, [main[0], other[1], main[1]])
        self.assertEqual(sa.missing_segments(lines, speech), [])


if __name__ == "__main__":
    unittest.main()
