# -*- coding: utf-8 -*-
"""
Синие флажки на карточках с Rover — один раз, в конце этапа 4.

Этап 4 видео закончен, когда все живые фрагменты переданы в Anki (у всех
есть карточки) и всем фрагментам с текстом больше не нужен перевод. В этот
момент карточки, где говорит Rover (герой игры), получают синий флаг — их
пользователь потом просматривает и снимает флаг, где он не нужен.

Делается ровно один раз на видео: отметка "rover_flags" в project.json. После
неё флаги не ставятся больше никогда — ни при новых карточках (объединение,
разделение, возврат из Anki), ни при повторном переводе, ни при перезапуске.
Снятый пользователем флаг синим уже не станет.

Уже стоящие флаги (оранжевый/зелёный/красный — правка, перевод) не
затираются: синий ставится только карточкам без флага.
"""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from common.manifest_schema import STATUS_ACTIVE, Manifest

from . import anki

ROVER_FLAG = 4  # синий флаг Anki
SETTING = "rover_flags"
# Реплика Rover: строка "Rover: ..." (имя говорящего до двоеточия).
ROVER_LINE = re.compile(r"^\s*Rover\s*:", re.M)


def has_rover(text: str) -> bool:
    return bool(ROVER_LINE.search(text or ""))


def _read_json(path: Path, default):
    import json

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def stage4_finished(project_dir: Path) -> bool:
    """Все живые фрагменты в Anki и переводить больше нечего (спрашивает Anki)."""
    from . import translator

    manifest = Manifest.load(project_dir / "manifest.json")
    active = [f for f in manifest.fragments if f.status == STATUS_ACTIVE]
    if not active or not all(f.exported for f in active):
        return False
    with_note = {e["fragment_id"] for e in _read_json(project_dir / "export" / "index.json", []) if e.get("anki_note_id")}
    if any(f.id not in with_note for f in active):
        return False
    return not translator.project_cards(project_dir)


def mark_if_finished(project_dir: Path, log=print) -> int | None:
    """
    Если этап 4 видео только что закончился и флаги ещё не ставились — синие
    флаги карточкам с Rover. Возвращает число помеченных карточек или None
    (рано / уже делалось / Anki недоступен).
    """
    from webapp.library import project_settings, save_project_settings

    project_dir = Path(project_dir)
    if project_settings(project_dir).get(SETTING):
        return None  # уже делалось — больше никогда
    try:
        if not stage4_finished(project_dir):
            return None
        manifest = Manifest.load(project_dir / "manifest.json")
        rover = {f.id for f in manifest.fragments if f.status == STATUS_ACTIVE and has_rover(f.text)}
        note_ids = [e["anki_note_id"] for e in _read_json(project_dir / "export" / "index.json", [])
                    if e.get("anki_note_id") and e["fragment_id"] in rover]
        cards = []
        if note_ids:
            card_ids = [c for n in anki.invoke("notesInfo", notes=note_ids) for c in n.get("cards", [])]
            cards = [c["cardId"] for c in anki.invoke("cardsInfo", cards=card_ids) if not c.get("flags")]
        if cards:
            anki.invoke("multi", actions=[
                {"action": "setSpecificValueOfCard", "params": {"card": c, "keys": ["flags"], "newValues": [ROVER_FLAG]}}
                for c in cards])
    except (anki.AnkiUnavailable, RuntimeError):
        return None  # Anki закрыт — попробуем при следующем случае
    # Отметка — сразу после флагов: повторно этот шаг уже не сработает.
    settings = project_settings(project_dir)
    settings[SETTING] = {"done": datetime.now().isoformat(timespec="seconds"), "cards": len(cards)}
    save_project_settings(project_dir, settings)
    log(f"{project_dir.name}: этап 4 закончен — синий флаг на {len(cards)} карточках с Rover")
    return len(cards)
