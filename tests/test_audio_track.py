# -*- coding: utf-8 -*-
"""Нарезка звука для редактора: кусок WAV ровно по сэмплам кадров."""
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.audio_track import AUDIO_CHANNELS, AUDIO_RATE, FRAME_BYTES, sample_for_frame, wav_slice


class TestWavSlice(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.pcm = Path(self._tmp.name) / "audio.pcm"
        # Дорожка-линейка: в сэмпле n оба канала хранят n % 30000 — по
        # значению сразу видно, какой это сэмпл.
        samples = [n % 30000 for n in range(AUDIO_RATE * 3)]
        self.pcm.write_bytes(b"".join(struct.pack("<hh", v, v) for v in samples))

    def tearDown(self):
        self._tmp.cleanup()

    def _samples(self, wav):
        data = wav[44:]
        return [struct.unpack_from("<h", data, i * FRAME_BYTES)[0] for i in range(len(data) // FRAME_BYTES)]

    def test_slice_is_exact_and_has_valid_header(self):
        fps = 30000 / 1001
        start, end = sample_for_frame(10, fps), sample_for_frame(20, fps)
        wav, actual_start = wav_slice(self.pcm, start, end)
        self.assertEqual(actual_start, start)
        riff, size, wave, fmt, channels, rate = struct.unpack_from("<4sI4s4s6xHI", wav, 0)
        self.assertEqual((riff, wave, fmt, channels, rate), (b"RIFF", b"WAVE", b"fmt ", AUDIO_CHANNELS, AUDIO_RATE))
        values = self._samples(wav)
        self.assertEqual(len(values), end - start)
        self.assertEqual(values[0], start % 30000)
        self.assertEqual(values[-1], (end - 1) % 30000)

    def test_slice_is_clamped_to_track(self):
        wav, actual_start = wav_slice(self.pcm, AUDIO_RATE * 3 - 100, AUDIO_RATE * 5)
        self.assertEqual(len(self._samples(wav)), 100)


if __name__ == "__main__":
    unittest.main()
