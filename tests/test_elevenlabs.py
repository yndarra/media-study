# -*- coding: utf-8 -*-
"""Ответ ElevenLabs Speech-to-Text -> формат whisper_transcript.json."""
import unittest

from phase1_ingest.transcribe_elevenlabs import _to_whisper_format


class TestFormat(unittest.TestCase):
    def test_words_grouped_into_phrases(self):
        reply = {"language_code": "eng", "audio_duration_secs": 9.0, "words": [
            {"text": "Hello", "start": 0.0, "end": 0.4, "type": "word", "speaker_id": "speaker_0"},
            {"text": " ", "start": 0.4, "end": 0.5, "type": "spacing"},
            {"text": "there.", "start": 0.5, "end": 0.9, "type": "word"},
            {"text": "(laughs)", "start": 1.0, "end": 1.5, "type": "audio_event"},
            {"text": "Next", "start": 1.2, "end": 1.5, "type": "word"},
            {"text": "line", "start": 3.0, "end": 3.4, "type": "word"},
        ]}
        out = _to_whisper_format(reply)
        self.assertEqual([s["text"] for s in out["segments"]], ["Hello there.", "Next", "line"])
        self.assertEqual(out["segments"][0]["words"][0], {"start": 0.0, "end": 0.4, "word": "Hello", "speaker_id": "speaker_0"})
        self.assertEqual(out["duration"], 9.0)


if __name__ == "__main__":
    unittest.main()
