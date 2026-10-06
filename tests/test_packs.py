# -*- coding: utf-8 -*-
"""Наборы от сообщества: сдвиг своей копии видео по огибающей громкости."""
import unittest

import numpy as np

from media_study import packs


class TestFindShift(unittest.TestCase):
    def envelope(self, seconds=120, fps=30, seed=1):
        rng = np.random.default_rng(seed)
        # Речь – всплески громкости разной длины.
        env = np.zeros(int(seconds * fps), dtype=np.uint8)
        t = 0
        while t < len(env):
            n = int(rng.integers(10, 60))
            env[t:t + n] = rng.integers(60, 250)
            t += n + int(rng.integers(5, 40))
        return env

    def test_same_copy_no_shift(self):
        env = self.envelope().tobytes()
        self.assertAlmostEqual(packs.find_shift(env, 30, env, 30), 0.0, places=1)

    def test_own_copy_later(self):
        env = self.envelope()
        own = np.concatenate([np.zeros(45, dtype=np.uint8), env])  # +1,5 с
        self.assertAlmostEqual(packs.find_shift(env.tobytes(), 30, own.tobytes(), 30), 1.5, places=1)

    def test_different_fps(self):
        env = self.envelope(fps=30)
        own = np.repeat(env, 2)[: len(env) * 2]  # та же копия, 60 кадров/с
        self.assertAlmostEqual(packs.find_shift(env.tobytes(), 30, own.tobytes(), 60), 0.0, places=1)

    def test_validate(self):
        with self.assertRaises(ValueError):
            packs.validate({"format": "other"})
        packs.validate({"format": packs.FORMAT, "version": 1, "fragments": [{"start": 0, "end": 1, "text": "Hi."}]})


if __name__ == "__main__":
    unittest.main()
