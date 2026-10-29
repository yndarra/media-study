# -*- coding: utf-8 -*-
"""
Перенос видео в другое хранилище (media_study/web/storage.py): маленький
проект между двумя временными папками. Состояние переноса должно содержать
все поля, которые читают «Сейчас идёт» и отметка вкладок (finished, error…):
однажды они пропали, и любой запрос во время переноса падал с ошибкой 500.
"""
import tempfile
import unittest
from pathlib import Path

from media_study.web import storage


class TestStorageMove(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.data = root / "data"
        self.dest = root / "other"
        (self.data / "proj").mkdir(parents=True)
        self.dest.mkdir()
        (self.data / "proj" / "manifest.json").write_text("{}", encoding="utf-8")
        (self.data / "proj" / "clip.bin").write_bytes(b"x" * 4096)

    def tearDown(self):
        storage.MOVES.pop("proj", None)
        self._tmp.cleanup()

    def test_move_state_and_result(self):
        storage.move(self.data, "proj", str(self.dest))
        state = storage.MOVES["proj"]
        for key in ("done", "total", "dest", "error", "finished"):
            self.assertIn(key, state)
        self.assertTrue(state["finished"])
        self.assertEqual(state["error"], "")
        # Только буква диска ("D:") – без метки тома.
        self.assertRegex(state["dest"], r"^[A-Za-z]:$")
        # Файлы – в новом месте, по старому адресу – ссылка туда же.
        self.assertTrue((self.data / "proj" / "clip.bin").exists())
        self.assertEqual((self.data / "proj" / "clip.bin").stat().st_size, 4096)
        self.assertTrue(any(self.dest.rglob("clip.bin")))
        # «Сейчас идёт» не падает на состоянии переноса.
        storage.activity()


if __name__ == "__main__":
    unittest.main()
