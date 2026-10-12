# -*- coding: utf-8 -*-
"""
Режим "говорящие на карточках": переключение возвращает переданные фрагменты,
повторное (обратно) – отменяет возврат у тех, что с тех пор не трогали.
И отметка "только озвучка".
"""
import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from media_study.core.manifest import Fragment, Manifest, VideoInfo, STATUS_ACTIVE


def _fragment(k: int, exported: bool) -> Fragment:
    return Fragment(
        id=f"frag_{k:04d}", status=STATUS_ACTIVE,
        algo_start_frame=k * 10, algo_end_frame=k * 10 + 10,
        context_start_frame=k * 10, context_end_frame=k * 10 + 10,
        original_algo_start_frame=k * 10, original_algo_end_frame=k * 10 + 10,
        text=f"Speaker: line {k}", exported=exported,
    )


class TestSpeakersUndo(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.project_dir = Path(self._tmp.name) / "tiny"
        (self.project_dir / "export").mkdir(parents=True)
        video = VideoInfo(youtube_url="https://example.invalid", video_id="tiny", title="tiny",
                          fps=10.0, total_frames=40, source_file="source.mp4")
        # Три переданных в Anki и один ещё нет.
        fragments = [_fragment(0, True), _fragment(1, True), _fragment(2, True), _fragment(3, False)]
        Manifest(video=video, fragments=fragments).save(self.project_dir / "manifest.json")
        # Карточки "уже созданы" (anki_note_id) – иначе сервер при запуске поднял бы фоновую очередь.
        index = [{"fragment_id": f.id, "clip": f"{k + 1:04d}.mp4", "text": f.text, "anki_note_id": 1000 + k}
                 for k, f in enumerate(fragments[:3])]
        (self.project_dir / "export" / "index.json").write_text(json.dumps(index), encoding="utf-8")
        (self.project_dir / "project.json").write_text(json.dumps({"show_speakers": True}), encoding="utf-8")

        self._old_env = os.environ.get("MEDIA_STUDY_DATA_DIR")
        os.environ["MEDIA_STUDY_DATA_DIR"] = str(self.project_dir.parent)
        # AnkiConnect нет (порт заведомо пустой) – тексты из Anki не подтягиваются.
        self._old_anki = os.environ.get("MEDIA_STUDY_ANKI_URL")
        os.environ["MEDIA_STUDY_ANKI_URL"] = "http://127.0.0.1:9"
        import media_study.export.anki as anki_module
        importlib.reload(anki_module)
        import media_study.web.server as server_module
        importlib.reload(server_module)
        from fastapi.testclient import TestClient

        self.client = TestClient(server_module.app)

    def tearDown(self):
        for name, value in (("MEDIA_STUDY_DATA_DIR", self._old_env), ("MEDIA_STUDY_ANKI_URL", self._old_anki)):
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        import media_study.export.anki as anki_module
        importlib.reload(anki_module)
        self._tmp.cleanup()

    def fragments(self) -> dict:
        return {f.id: f for f in Manifest.load(self.project_dir / "manifest.json").fragments}

    def index(self) -> dict:
        return {e["fragment_id"]: e for e in json.loads((self.project_dir / "export" / "index.json").read_text(encoding="utf-8"))}

    def toggle(self, on: bool) -> dict:
        response = self.client.post("/api/p/tiny/speakers", json={"on": on})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_toggle_back_restores_untouched(self):
        result = self.toggle(False)
        self.assertEqual((result["returned"], result["restored"]), (3, 0))
        self.assertTrue(all(not self.fragments()[f"frag_{k:04d}"].exported for k in range(3)))
        self.assertTrue(all(self.index()[f"frag_{k:04d}"].get("redo") for k in range(3)))
        # Один фрагмент поправили – он останется вернувшимся.
        response = self.client.patch("/api/p/tiny/fragments/frag_0001", json={"text": "Speaker: changed"})
        self.assertEqual(response.status_code, 200, response.text)

        result = self.toggle(True)
        self.assertEqual((result["returned"], result["restored"]), (0, 2))
        fragments = self.fragments()
        self.assertTrue(fragments["frag_0000"].exported and fragments["frag_0002"].exported)
        self.assertFalse(fragments["frag_0000"].anki_flagged)
        self.assertFalse(fragments["frag_0001"].exported)
        self.assertTrue(fragments["frag_0001"].anki_flagged)
        index = self.index()
        self.assertFalse(index["frag_0000"].get("redo"))
        self.assertTrue(index["frag_0001"].get("redo"))
        self.assertFalse(fragments["frag_0003"].exported)  # не переданный – как был

    def test_third_toggle_returns_again(self):
        self.toggle(False)
        self.toggle(True)
        result = self.toggle(False)
        self.assertEqual((result["returned"], result["restored"]), (3, 0))

    def test_sound_only_excludes_unvoiced(self):
        response = self.client.post("/api/p/tiny/fragments/frag_0003/sound-only", json={"value": True})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["sound_only"])
        response = self.client.post("/api/p/tiny/fragments/frag_0003/unvoiced", json={"value": True})
        self.assertTrue(response.json()["unvoiced"])
        self.assertFalse(response.json()["sound_only"])


if __name__ == "__main__":
    unittest.main()
