# -*- coding: utf-8 -*-
"""Синие флаги Rover: кто считается репликой Rover и что флаги ставятся один раз."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from phase3_export import rover_flags


class TestRoverFlags(unittest.TestCase):
    def test_rover_line(self):
        self.assertTrue(rover_flags.has_rover("Chixia: Hi!\nRover: Hello."))
        self.assertFalse(rover_flags.has_rover("Rovers: no"))
        self.assertFalse(rover_flags.has_rover("Chixia: Rover: is a name in text"))

    def test_only_once(self):
        # Отметка в project.json уже есть — Anki не спрашивается вовсе, флаги не ставятся.
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / "project.json").write_text(json.dumps({"rover_flags": {"done": "x", "cards": 3}}), encoding="utf-8")
            with mock.patch.object(rover_flags.anki, "invoke") as invoke, \
                    mock.patch.object(rover_flags, "stage4_finished") as finished:
                self.assertIsNone(rover_flags.mark_if_finished(project, log=lambda m: None))
                invoke.assert_not_called()
                finished.assert_not_called()


if __name__ == "__main__":
    unittest.main()
