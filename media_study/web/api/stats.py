# -*- coding: utf-8 -*-
"""Статистика по всем видео (расходы OpenRouter, правка, Anki) и результаты таймера правки.

Часть сервера (media_study/web/server.py): маршруты регистрируются на тот же app.
"""
import threading
import time
import uuid

from fastapi import HTTPException
from pydantic import BaseModel

from media_study.web import library
from ..server import DATA_DIR, app
from .stage3 import _anki_flag_counts, _anki_flags_cache, _disk_total
from .system import _editor_seconds


@app.get("/api/stats")
def overall_stats():
    """
    Раздел "Статистика": по каждому видео – длительность, правка, Anki,
    перевод, место на диске и расходы OpenRouter (страница сама считает итоги).
    """
    _anki_flag_counts()  # обновить кэш "переведено" (не чаще раза в минуту)
    translated = _anki_flags_cache.get("translated", {})
    videos = []
    for item in library.list_projects(DATA_DIR):
        row = {key: item.get(key) for key in (
            "id", "title", "group", "state", "duration", "fragments_total", "active_total", "cards_total",
            "reviewed", "edit_bar", "in_anki", "exported", "deleted_total", "bar_total", "flagged", "audio_only")}
        row["costs"] = library.project_settings(DATA_DIR / item["id"]).get("costs", {})
        row["translated"] = translated.get(item["id"], 0) if item["state"] == "ready" else 0
        row["disk_total"] = _disk_total(item["id"])
        row["editor_seconds"] = _editor_seconds(item["id"])
        videos.append(row)
    return {"videos": videos, "openrouter_usage": _openrouter_usage()}


# Сколько всего потрачено по ключу OpenRouter (его собственный счётчик) – для
# "Статистики": итог совпадает с OpenRouter, а не только с учтёнными по видео
# расходами. Спрашивается не чаще раза в 5 минут.
_usage_cache: dict = {"at": 0.0, "value": None}


def _openrouter_usage() -> float | None:
    """Последнее известное значение сразу; устарело – обновляется в фоне (страница не ждёт сеть)."""
    if time.time() - _usage_cache["at"] >= 300 and not _usage_cache.get("busy"):
        _usage_cache["busy"] = True

        def refresh():
            from media_study.export.translator import _post

            try:
                reply = _post(DATA_DIR, "/key", None, "GET")
                _usage_cache["value"] = float((reply.get("data") or reply).get("usage") or 0)
            except Exception:  # нет сети / ключа – покажем только учтённое
                pass
            _usage_cache.update(at=time.time(), busy=False)

        threading.Thread(target=refresh, daemon=True).start()
    return _usage_cache["value"]


# -- результаты таймера правки (кнопка "Сохранить" у таймера, раздел "Статистика") --
TIMER_FILE = "timer_results.json"


def _timer_results() -> list[dict]:
    return library.read_json(DATA_DIR / TIMER_FILE, [])


def _save_timer_results(items: list[dict]) -> None:
    from media_study.export.agent import save_json

    save_json(DATA_DIR / TIMER_FILE, items)


@app.get("/api/timer")
def timer_results():
    """Сохранённые результаты таймера (новые – первыми)."""
    return sorted(_timer_results(), key=lambda r: r.get("saved_at", ""), reverse=True)


class TimerResult(BaseModel):
    ms: int  # время работы таймера
    frags: int  # отредактировано фрагментов за это время
    project: str | None = None  # видео, открытое в редакторе


@app.post("/api/timer")
def save_timer_result(body: TimerResult):
    if body.ms < 1000:
        raise HTTPException(status_code=400, detail="Таймер ещё не запускали")
    from datetime import datetime

    item = {"id": uuid.uuid4().hex[:12], "saved_at": datetime.now().isoformat(timespec="seconds"),
            "ms": body.ms, "frags": body.frags, "project": body.project,
            "title": library.title_of(DATA_DIR / body.project) if body.project and (DATA_DIR / body.project).is_dir() else ""}
    _save_timer_results(_timer_results() + [item])
    return item


@app.delete("/api/timer/{result_id}")
def delete_timer_result(result_id: str):
    items = _timer_results()
    left = [r for r in items if r.get("id") != result_id]
    if len(left) == len(items):
        raise HTTPException(status_code=404, detail="нет такого результата")
    _save_timer_results(left)
    return {"ok": True}
