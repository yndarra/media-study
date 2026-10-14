# -*- coding: utf-8 -*-
"""Раздел Anki: сводка по всем видео, проверка флагов, возврат карточек на правку.

Часть сервера (media_study/web/server.py): маршруты регистрируются на тот же app.
"""
from fastapi import HTTPException
from pydantic import BaseModel

from media_study.web import library
from ..server import DATA_DIR, app, project
from .stage3 import (
    INTERVAL_FLAGS,
    TRANSLATION_FLAGS,
    _anki_flag_counts,
    _anki_flags_cache,
    _disk_total,
    _stage3_status,
)
from .settings import _translation_activity


@app.get("/api/anki/overview")
def anki_overview():
    """Раздел "Видео": по каждому готовому видео — прогресс правки, Anki и очередь."""
    result = []
    flags = _anki_flag_counts()
    # Видео, которые сейчас переводятся (идёт агент или ждёт пакетная заявка).
    translating = {a["id"] for a in _translation_activity() if a.get("id")}
    for item in library.list_projects(DATA_DIR):
        if item["state"] != "ready":
            continue
        item["translated"] = _anki_flags_cache.get("translated", {}).get(item["id"], 0)
        item["disk_total"] = _disk_total(item["id"])
        # Буква диска, где лежит медиа (основное хранилище или ссылка на другой диск).
        from .. import storage as _storage

        item["drive"] = _storage.location(DATA_DIR, item["id"])["label"][:2]
        _card_states(item, flags, translating)
        result.append(item)
    from .. import storage

    result += storage.offline_projects(DATA_DIR)
    return result


def _card_states(item: dict, flags: dict, translating: set) -> None:
    """
    Этап видео для оформления карточки (список видео) и окна подробностей:
    complete / ready_to_send / sending / ready_to_translate / translating.
    item — library.summary с уже посчитанным "translated".
    """
    item["stage3"] = _stage3_status(project(item["id"]))
    per = {int(k): v for k, v in flags.get(item["id"], {}).items()}
    item["anki_flags"] = per
    item["flag_interval"] = sum(per.get(f, 0) for f in INTERVAL_FLAGS)
    item["flag_translation"] = sum(per.get(f, 0) for f in TRANSLATION_FLAGS)
    # Видео готово целиком: всё отредактировано и передано в Anki, ничего
    # не вернулось на правку и все карточки переведены.
    item["complete"] = bool(
        item["active_total"] and item["exported"] == item["active_total"] and item["reviewed"] >= item["fragments_total"]
        and not item["flagged"] and not item["flag_interval"]
        # Переведены все фрагменты с текстом (пустые карточки "без_текста" перевода не ждут).
        and item["translated"] >= item["cards_total"] > 0
    )
    # Идёт передача в Anki (клипы кодируются / карточки создаются).
    q = item["stage3"] or {}
    item["sending"] = bool(q.get("pending") or q.get("notes_left"))
    # Всё, что можно, отредактировано (не тронутых и вернувшихся нет), но ещё
    # не всё в Anki (в том числе пока передаётся) — синяя карточка. Цвет
    # меняется, только когда передача закончилась.
    item["ready_to_send"] = bool(
        item["active_total"] and not item["awaiting"] and (item["exported"] < item["active_total"] or item["sending"])
    )
    # Всё передано в Anki, править нечего, осталось только перевести —
    # розоватая карточка с кнопкой "Перевести".
    item["ready_to_translate"] = bool(
        item["active_total"] and not item["complete"] and not item["awaiting"] and not item["sending"]
        and item["exported"] == item["active_total"] and not item["flagged"] and not item["flag_interval"]
        and item["translated"] < item["cards_total"]
    )
    item["translating"] = item["id"] in translating
    from .. import storage

    # Видео переносится на другой диск: кнопка "Перемещение…" на карточке,
    # править и запускать процессы нельзя.
    item["moving"] = storage.moving(item["id"])


@app.post("/api/anki/check")
def anki_check():
    """Карточки приложения (тип media-study) с любым флагом — кандидаты на доработку."""
    from media_study.export import anki

    try:
        flagged = anki.flagged_notes()
    except anki.AnkiUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error))
    for item in flagged:
        manifest_path = DATA_DIR / item["project"] / "manifest.json"
        state = "unknown"
        if manifest_path.exists():
            manifest = project(item["project"]).store.load()
            fragment = next((f for f in manifest.fragments if f.id == item["fragment_id"]), None)
            if fragment is not None:
                state = "in_anki" if fragment.exported else "returned"
        item["state"] = state
    return flagged


class ReturnItem(BaseModel):
    project: str
    fragment_id: str


class ReturnRequest(BaseModel):
    items: list[ReturnItem]
