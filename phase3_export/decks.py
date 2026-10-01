# -*- coding: utf-8 -*-
"""
Колоды Anki видео: <корень из настроек>::<автор>::<название>.

Если поменяли корень (Настройки), автора или название (подробности видео),
карточки видео переезжают в новую колоду (changeDeck — история повторений
сохраняется), а старая колода и её пустые родители удаляются — только если
в них не осталось ни карточек, ни подколод (чужое не трогается никогда;
колода верхнего уровня, например "Claude", не удаляется).

Если Anki закрыт — перенос откладывается (сервер повторяет его, пока Anki не
откроется; в Настройках видно, что он ждёт).
"""
from pathlib import Path

from . import anki


def target_deck(project_dir: Path) -> str:
    from .worker import default_deck

    return default_deck(project_dir)


def _cards_of_project(project_id: str) -> list[int]:
    return anki.invoke("findCards", query=f'"tag:{anki.TAG}::{project_id}::*"')


def _deck_empty(name: str, all_names: list[str], ids: dict[str, int]) -> bool:
    """Нет подколод и нет карточек (по id колоды — без особых символов в поиске)."""
    if any(other.startswith(name + "::") for other in all_names):
        return False
    deck_id = ids.get(name)
    return deck_id is not None and not anki.invoke("findCards", query=f"did:{deck_id}")


def _remove_empty(old: str, keep: str) -> None:
    """Старая колода и её родители — прочь, пока они пустые (и не ведут к новой)."""
    ids = anki.invoke("deckNamesAndIds")
    names = list(ids)
    name = old
    while "::" in name:
        if keep == name or keep.startswith(name + "::"):
            break
        if name not in ids or not _deck_empty(name, names, ids):
            break
        anki.invoke("deleteDecks", decks=[name], cardsToo=True)  # колода пустая — удалять нечего
        names.remove(name)
        name = name.rsplit("::", 1)[0]


def move_project(project_id: str, old: str | None, new: str) -> int:
    """Карточки видео — в колоду new; пустая старая колода удаляется. Возвращает, сколько перенесено."""
    cards = _cards_of_project(project_id)
    anki.invoke("createDeck", deck=new)
    if cards:
        anki.invoke("changeDeck", cards=cards, deck=new)
    if old and old != new:
        _remove_empty(old, new)
    return len(cards)


def sync(data_dir: Path, set_deck) -> dict:
    """
    Все видео, у которых колода в манифесте не совпадает с нужной, переносятся.
    set_deck(project_id, deck) записывает новую колоду в манифест (сервер —
    через своё хранилище, под блокировкой). Возвращает {"moved": [...],
    "pending": bool, "message": str}.
    """
    from common.manifest_schema import Manifest

    moved, todo = [], []
    for project_dir in sorted(Path(data_dir).iterdir()):
        manifest_path = project_dir / "manifest.json"
        if not manifest_path.exists():
            continue
        current = Manifest.load(manifest_path).settings.get("anki_deck")
        if not current:
            continue  # в Anki ещё ничего не передавали — колода создастся при передаче
        target = target_deck(project_dir)
        if current != target:
            todo.append((project_dir.name, current, target))
    try:
        for project_id, current, target in todo:
            count = move_project(project_id, current, target)
            set_deck(project_id, target)
            moved.append({"project": project_id, "from": current, "to": target, "cards": count})
    except anki.AnkiUnavailable:
        return {"moved": moved, "pending": True, "message": "Anki не подключён — колоды переименуются, когда он откроется"}
    return {"moved": moved, "pending": False, "message": ""}
