# -*- coding: utf-8 -*-
"""
Ход этапа 1 для библиотеки веб-приложения.

Этап 1 долгий (часовое видео — десятки минут), поэтому каждый шаг пишет в
data/<id>/phase1_status.json, что сейчас делается и сколько процентов шага
готово: скачивание, копия для редактора, распознавание речи, нарезка.
Библиотека и страница "Скачать" показывают это полоской прогресса.
Писать не чаще раза в пару секунд — файл читается и так редко.
"""
from pathlib import Path
import json
import time

STATUS_FILE = "phase1_status.json"
STEPS = {
    "download": "скачиваю видео",
    "downloaded": "добавлено, ждёт обработки",
    "proxy": "делаю копию для редактора",
    "transcribe": "распознаю речь",
    "search": "ищу текст для сверки",
    "segment": "режу на фразы",
    "assets": "строю звуковую волну и дорожку",
    "done": "готово",
}

_last_write: dict[tuple, float] = {}


def report(project_dir: Path, step: str, percent: float | None = None, force: bool = False) -> None:
    project_dir = Path(project_dir)
    key = (str(project_dir), step)
    now = time.time()
    if not force and now - _last_write.get(key, 0.0) < 2.0 and percent not in (None, 100):
        return
    _last_write[key] = now
    status = {
        "step": step,
        "label": STEPS.get(step, step),
        "percent": None if percent is None else round(max(0.0, min(100.0, percent)), 1),
        "updated": now,
    }
    path = project_dir / STATUS_FILE
    tmp_path = path.with_suffix(".json.tmp")
    try:
        project_dir.mkdir(parents=True, exist_ok=True)
        tmp_path.write_text(json.dumps(status, ensure_ascii=False), encoding="utf-8")
        tmp_path.replace(path)
    except OSError:
        pass  # прогресс — только для показа, этап 1 из-за него не должен падать
