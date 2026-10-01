# -*- coding: utf-8 -*-
"""Перевод пачками: запрос (кэш текста видео) и разбор ответа в предложения."""
import unittest

from phase3_export import translator


def card(i, text="Hello.", flag=0):
    return {"id": f"{i:04d}", "note_id": i, "fragment_id": f"frag_{i}", "flag": flag, "project": "p",
            "front_old": f"[sound:p_{i:04d}.mp4]<br>{text}", "back_old": "", "front_new": f"[sound:p_{i:04d}.mp4]<br>{text}",
            "text": text, "speaker_text": f"Rover: {text}", "back_text": "", "comments": []}


class TestTranslator(unittest.TestCase):
    def test_request_caches_transcript_and_lists_batch(self):
        body = translator.request_body("m", "ТЕКСТ ВИДЕО", [card(1), card(2)], {"Rover": "не переводится"})
        transcript_part, batch_part = body["messages"][1]["content"]
        self.assertEqual(transcript_part["cache_control"], {"type": "ephemeral"})
        self.assertIn("ТЕКСТ ВИДЕО", transcript_part["text"])
        self.assertIn("#0001", batch_part["text"])
        self.assertIn("Rover – не переводится", batch_part["text"])

    def test_answer_to_proposals(self):
        answer = {"cards": [
            {"id": "0001", "translation": "Привет.", "terms": [{"phrase": "hello", "meaning": "привет — приветствие"}]},
            {"id": "#0002", "translation": "Пока."},
        ]}
        proposals = translator.proposals_from(answer, [card(1), card(2), card(3)], "m", 0.3, "p:0001-0003")
        self.assertEqual([p["note_id"] for p in proposals], [1, 2])  # третьей нет в ответе — пропуск
        self.assertEqual(proposals[0]["back_new"], "Привет.<br><br><i>hello</i> – привет – приветствие")
        self.assertEqual(proposals[0]["batch"], "p:0001-0003")

    def test_chunks(self):
        self.assertEqual([len(c) for c in translator.chunks(list(range(85)))], [40, 40, 5])


class TestParseAnswer(unittest.TestCase):
    def test_empty_reply_is_retryable_error(self):
        # Пустой ответ модели — ValueError (пачка повторится), а не падение агента.
        for content in (None, ""):
            with self.assertRaises(ValueError):
                translator.parse_answer(content)

    def test_json_inside_text(self):
        self.assertEqual(translator.parse_answer('вот: {"cards": []} конец'), {"cards": []})


if __name__ == "__main__":
    unittest.main()
