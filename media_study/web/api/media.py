# -*- coding: utf-8 -*-
"""Библиотека: список медиа, сводки, статистика окна, место на диске, хранилища и перенос.

Часть сервера (media_study/web/server.py): маршруты регистрируются на тот же app.
"""
import os

from fastapi import HTTPException
from pydantic import BaseModel

from media_study.web import library
from ..server import DATA_DIR, app, project
from .stage3 import _anki_flag_counts, _anki_flags_cache, _disk_cache, _disk_total, _stage3_status
from .settings import _deck_sync_run, _deck_sync_state, _translation_activity
from .anki import _card_states


# -- библиотека ---------------------------------------------------------------------


@app.get("/api/projects")
def list_projects():
    return library.list_projects(DATA_DIR)


@app.get("/api/p/{project_id}/summary")
def project_summary(project_id: str):
    return library.summary(project(project_id).dir)


@app.get("/api/p/{project_id}/stats")
def project_stats(project_id: str):
    p = project(project_id)
    summary = library.summary(p.dir)
    _anki_flag_counts()  # обновить кэш переведённых, если устарел
    summary["translated"] = _anki_flags_cache.get("translated", {}).get(project_id, 0)
    # Сколько фрагментов ещё без перевода (и переданные в Anki, и нет) — для кнопки "Перевести".
    from media_study.export import anki, translator

    try:
        summary["to_translate"] = len(translator.project_cards(p.dir))
        # Окно видео – точное число прямо из Anki, без кэша: перевод пишется пачками
        # и должен быть виден сразу (в списке видео – кэш на минуту).
        summary["translated"] = translator.in_anki_text_count(p.dir) - summary["to_translate"]
    except (anki.AnkiUnavailable, RuntimeError):
        summary["to_translate"] = None  # Anki закрыт — неизвестно
        # Переведено – последнее известное (иначе при закрытом Anki было бы 0).
        summary["translated"] = _anki_flags_cache.get("translated", {}).get(project_id, 0)
    summary["id"] = project_id
    _card_states(summary, _anki_flag_counts(), {a["id"] for a in _translation_activity() if a.get("id")})
    return {"summary": summary, "stats": library.stats(p.dir), "disk": library.disk_usage(p.dir),
            "deck_sync": _deck_sync_state(), "storage": _storage_info(project_id)}


@app.get("/api/p/{project_id}/disk")
def project_disk(project_id: str):
    """Место на диске по этапам — и для видео, которое ещё не обработано."""
    project_dir = DATA_DIR / project_id
    if not project_dir.is_dir():
        raise HTTPException(status_code=404, detail="видео не найдено")
    return {**library.disk_usage(project_dir), "storage": _storage_info(project_id)}


def _storage_info(project_id: str) -> dict:
    """Где лежит видео, куда его можно перенести и как идёт перенос."""
    from .. import storage

    here = storage.location(DATA_DIR, project_id)
    # Свободное место на текущем – для строки "сейчас здесь" в окне хранилища.
    for s in storage.storages(DATA_DIR):
        if os.path.normcase(s["path"]) == os.path.normcase(here["path"]) and "free" in s:
            here["free"], here["total"] = s["free"], s["total"]
    move = storage.MOVES.get(project_id)
    return {
        "here": here,
        "targets": [s for s in storage.storages(DATA_DIR)
                    if s["online"] and os.path.normcase(s["path"]) != os.path.normcase(here["path"])],
        "move": move and {**{k: move[k] for k in ("done", "total", "dest", "error", "finished")}, "waiting": move.get("waiting", "")},
    }


@app.get("/api/storages")
def list_storages():
    """Хранилища (настройки): путь, диск, свободно / всего, сколько видео и места занимают."""
    from .. import storage

    result = storage.storages(DATA_DIR)
    for s in result:
        s["videos"], s["used"] = 0, 0
    for link in DATA_DIR.iterdir():
        if not link.is_dir() or not any((link / m).exists() for m in ("manifest.json", "video_info.json", "phase1_status.json")):
            continue
        here = storage.location(DATA_DIR, link.name)
        for s in result:
            if os.path.normcase(s["path"]) == os.path.normcase(here["path"]):
                s["videos"] += 1
                s["used"] += _disk_total(link.name)
    return result


@app.post("/api/p/{project_id}/move/cancel")
def cancel_move(project_id: str):
    """Отменить перенос на другой диск (видео остаётся на старом месте)."""
    from .. import storage

    if not storage.cancel_move(project_id):
        raise HTTPException(status_code=400, detail="перенос не идёт")
    return {"ok": True}


@app.get("/api/p/{project_id}/edit_state")
def edit_state(project_id: str):
    """
    Можно ли открыть видео в редакторе: нельзя, пока оно переносится на
    другой диск; и пока идёт передача в Anki или перевод, если править уже
    нечего (все фрагменты переданы/передаются).
    """
    from .. import storage

    project_dir = DATA_DIR / project_id
    if storage.moving(project_id):
        return {"locked": True, "reason": "Видео переносится на другой диск – править можно после переноса"}
    if not (project_dir / "manifest.json").exists():
        return {"locked": False, "reason": ""}
    item = library.summary(project_dir)
    busy = _stage3_status(project(project_id))["notes_left"] or project_id in {
        a["id"] for a in _translation_activity() if a.get("id")}
    if busy and not item.get("editable"):
        return {"locked": True, "reason": "Идёт передача в Anki или перевод, а править больше нечего"}
    return {"locked": False, "reason": ""}


class MoveRequest(BaseModel):
    dest: str


@app.post("/api/p/{project_id}/move")
def move_project(project_id: str, body: MoveRequest):
    """
    Перенести видео в другое хранилище (копия -> ссылка -> удаление старого).
    Нельзя, пока над видео идёт процесс: обработка, передача в Anki, перевод.
    """
    from .. import storage

    project_dir = DATA_DIR / project_id
    if not project_dir.is_dir():
        raise HTTPException(status_code=404, detail="видео не найдено")
    known = [s["path"] for s in storage.storages(DATA_DIR)]
    if not any(os.path.normcase(body.dest) == os.path.normcase(p) for p in known):
        raise HTTPException(status_code=400, detail="такого хранилища нет в настройках")
    item = library.summary(project_dir)
    busy = item["state"] == "processing" or (item["state"] == "ready" and _stage3_status(project(project_id), fresh=True)["notes_left"]) \
        or project_id in {a["id"] for a in _translation_activity() if a.get("id")}
    if busy:
        raise HTTPException(status_code=409, detail="Над видео идёт процесс – перенести можно после него")
    # Свободного места должно хватить (с запасом 1 ГБ).
    need = _disk_total(project_id)
    dest = next(s for s in storage.storages(DATA_DIR) if os.path.normcase(s["path"]) == os.path.normcase(body.dest))
    if dest.get("free", 0) < need + 2**30:
        raise HTTPException(status_code=400, detail="На диске не хватит места")
    # Закрыть копию видео в редакторе этого сервера нельзя – её держит браузер;
    # если файлы заняты, перенос сам сообщит об этом.
    try:
        storage.start_move(DATA_DIR, project_id, body.dest)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    _disk_cache.pop(project_id, None)
    return {"ok": True}


class ProjectSettingsRequest(BaseModel):
    group: str | None = None
    title: str | None = None


@app.patch("/api/p/{project_id}/settings")
def update_project_settings(project_id: str, body: ProjectSettingsRequest):
    """
    Переименовать автора (группу) и/или название видео. Колода Anki
    (<корень>::<автор>::<название>) переименовывается вслед — карточки
    переезжают в новую колоду (если Anki закрыт — когда он откроется).
    """
    project_dir = DATA_DIR / project_id
    if not project_dir.is_dir():
        raise HTTPException(status_code=404, detail="видео не найдено")
    settings = library.project_settings(project_dir)
    if body.group is not None and body.group.strip():
        settings["group"] = body.group.strip()
    if body.title is not None and body.title.strip():
        settings["title"] = body.title.strip()
    library.save_project_settings(project_dir, settings)
    _deck_sync_run()
    return {**library.summary(project_dir), "deck_sync": _deck_sync_state()}
