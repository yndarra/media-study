# -*- coding: utf-8 -*-
"""
Промежуточные клипы (export/ проекта) удаляются, когда тот же файл уже лежит
в медиа Anki (media_study/export/worker.py, Worker.drop_local_clips).
"""
import tempfile
import unittest
from pathlib import Path

from media_study.export.worker import Worker


class TestDropLocalClips(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.project = root / "data" / "vid"
        (self.project / "export").mkdir(parents=True)
        self.media = root / "collection.media"
        self.media.mkdir()
        self.worker = Worker(root / "data")
        self.worker._media_dir = self.media  # как будто Anki назвал свою папку медиа

    def tearDown(self):
        self._tmp.cleanup()

    def clip(self, name, size, in_anki=None):
        (self.project / "export" / name).write_bytes(b"x" * size)
        if in_anki is not None:
            (self.media / f"vid_{name}").write_bytes(b"x" * in_anki)

    def test_only_clips_already_in_anki_are_dropped(self):
        self.clip("0001.mp4", 100, in_anki=100)  # в Anki тот же файл – удалить
        self.clip("0002.mp4", 100)               # в Anki нет – оставить
        self.clip("0003.mp4", 100, in_anki=50)   # в Anki другой файл – оставить
        self.clip("0004.mp4", 100, in_anki=100)  # карточка ждёт обновления – оставить
        self.clip("0005.mp4", 100, in_anki=100)  # карточки ещё нет – оставить
        index = [
            {"clip": "0001.mp4", "anki_note_id": 1},
            {"clip": "0002.mp4", "anki_note_id": 2},
            {"clip": "0003.mp4", "anki_note_id": 3},
            {"clip": "0004.mp4", "anki_note_id": 4, "anki_update_pending": True},
            {"clip": "0005.mp4"},
        ]
        self.assertEqual(self.worker.drop_local_clips(self.project, index), 1)
        left = sorted(p.name for p in (self.project / "export").iterdir())
        self.assertEqual(left, ["0002.mp4", "0003.mp4", "0004.mp4", "0005.mp4"])
        self.assertTrue((self.media / "vid_0001.mp4").exists())  # в Anki ничего не трогаем


if __name__ == "__main__":
    unittest.main()
