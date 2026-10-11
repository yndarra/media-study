# -*- coding: utf-8 -*-
"""Тип заметок Anki из настроек (export/anki.py: model())."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from media_study.export import anki


class AnkiModelTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.data = Path(self.dir.name)
        self.env = mock.patch.dict(os.environ, {"MEDIA_STUDY_DATA_DIR": str(self.data)})
        self.env.start()
        anki._model_cache.clear()
        self.models = {"Моя": ["Вопрос", "Ответ", "Заметка"], "Basic": ["Front", "Back"], "Одно поле": ["Текст"]}
        self.calls = []

        def fake(action, **p):
            self.calls.append(action)
            if action == "modelNames":
                return list(self.models)
            if action == "modelFieldNames":
                return self.models[p["modelName"]]
            raise AssertionError(action)

        self.invoke = mock.patch.object(anki, "invoke", fake)
        self.invoke.start()

    def tearDown(self):
        self.invoke.stop()
        self.env.stop()
        anki._model_cache.clear()
        self.dir.cleanup()

    def settings(self):
        path = self.data / "settings.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def test_empty_setting_takes_basic_and_remembers(self):
        self.assertEqual((anki.MODEL_NAME, anki.FRONT_FIELD, anki.BACK_FIELD), ("Basic", "Front", "Back"))
        self.assertEqual(self.settings()["anki_model"], "Basic")

    def test_no_basic_takes_first(self):
        del self.models["Basic"]
        self.assertEqual(anki.MODEL_NAME, "Моя")
        self.assertEqual((anki.FRONT_FIELD, anki.BACK_FIELD), ("Вопрос", "Ответ"))

    def test_renamed_basic_is_preferred(self):
        del self.models["Basic"]
        self.models["1.2 Базовая (обратная)"] = ["Лицо", "Оборот"]
        self.models["1.1 Базовый"] = ["Лицо", "Оборот"]
        self.assertEqual(anki.MODEL_NAME, "1.1 Базовый")

    def test_setting_wins_and_missing_model_is_error(self):
        (self.data / "settings.json").write_text(json.dumps({"anki_model": "Моя"}), encoding="utf-8")
        self.assertEqual(anki.MODEL_NAME, "Моя")
        anki._model_cache.clear()
        (self.data / "settings.json").write_text(json.dumps({"anki_model": "Нет такого"}), encoding="utf-8")
        with self.assertRaises(RuntimeError):
            anki.ensure_model()

    def test_one_field_model_is_error(self):
        (self.data / "settings.json").write_text(json.dumps({"anki_model": "Одно поле"}), encoding="utf-8")
        with self.assertRaises(RuntimeError):
            anki.ensure_model()

    def test_cached_without_anki(self):
        anki.ensure_model()
        self.calls.clear()
        anki._model_cache["at"] = 0  # кэш устарел, но настройка та же – Anki не нужен
        self.assertEqual(anki.BACK_FIELD, "Back")
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
