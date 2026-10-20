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

Карточки без колоды (repair). Если карточки видео успели поучить на другом
устройстве, где ещё была старая колода, то при синхронизации через AnkiWeb
побеждает более поздняя версия карточки — вместе со старой колодой, которой
уже нет. В списке колод Anki такие карточки не видны и в повторения не
попадают. Сервер раз в несколько минут ищет их и возвращает в колоду видео
(история повторений сохраняется). Карточки в существующих колодах — в том
числе перенесённые туда вручную — не трогаются.
"""
from pathlib import Path

from . import anki
from .reverse import REV_TAG


def target_deck(project_dir: Path) -> str:
    from .worker import default_deck

    return default_deck(project_dir)


def _tags_query(project_id: str) -> str:
    """Прямые и обратные карточки видео (у обратных своя метка, см. reverse.py)."""
    return f'("tag:{anki.TAG}::{project_id}::*" OR "tag:{REV_TAG}::{project_id}::*")'


def _cards_of_project(project_id: str) -> list[int]:
    return anki.invoke("findCards", query=_tags_query(project_id))


def _multi(actions: list[dict]) -> list:
    """Несколько запросов AnkiConnect одним; ошибка любого из них — RuntimeError."""
    replies = anki.invoke("multi", actions=[{**action, "version": 6} for action in actions])
    for action, reply in zip(actions, replies):
        if reply.get("error"):
            raise RuntimeError(f"AnkiConnect {action['action']}: {reply['error']}")
    return [reply.get("result") for reply in replies]


def _video_decks(data_dir: Path) -> dict[str, str]:
    """Видео, которые уже передавали в Anki: id -> колода из манифеста."""
    from media_study.core.manifest import Manifest

    out = {}
    if not Path(data_dir).is_dir():
        return out
    for project_dir in sorted(Path(data_dir).iterdir()):
        manifest_path = project_dir / "manifest.json"
        if not manifest_path.exists():
            continue
        deck = Manifest.load(manifest_path).settings.get("anki_deck")
        if deck:  # в Anki ещё ничего не передавали — колода создастся при передаче
            out[project_dir.name] = deck
    return out


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
    moved, todo = [], []
    for project_id, current in _video_decks(data_dir).items():
        target = target_deck(Path(data_dir) / project_id)
        if current != target:
            todo.append((project_id, current, target))
    try:
        for project_id, current, target in todo:
            count = move_project(project_id, current, target)
            set_deck(project_id, target)
            moved.append({"project": project_id, "from": current, "to": target, "cards": count})
    except anki.AnkiUnavailable:
        return {"moved": moved, "pending": True, "message": "Anki не подключён — колоды переименуются, когда он откроется"}
    return {"moved": moved, "pending": False, "message": ""}


def repair(data_dir: Path) -> list[dict]:
    """
    Карточки видео без колоды (колоды с их id в Anki нет) — обратно в колоду
    видео из манифеста. Обычно находить нечего — тогда это два запроса.
    Возвращает [{"project", "to", "cards"}]. Anki закрыт — AnkiUnavailable.
    """
    videos = _video_decks(data_dir)
    if not videos:
        return []
    ids = anki.invoke("deckNamesAndIds")
    # did: — колоды по id (без подколод), несколько через запятую; карточка
    # в фильтрованной колоде лежит в ней (она тоже есть в списке) — не сирота.
    outside = " -did:" + ",".join(str(deck_id) for deck_id in ids.values())
    if not anki.invoke("findCards", query="(" + " OR ".join(map(_tags_query, videos)) + ")" + outside):
        return []
    pids = list(videos)
    found = _multi([{"action": "findCards", "params": {"query": _tags_query(pid) + outside}} for pid in pids])
    repaired = []
    for pid, cards in zip(pids, found):
        if cards:
            anki.invoke("createDeck", deck=videos[pid])  # колоду видео могли удалить вручную
            anki.invoke("changeDeck", cards=cards, deck=videos[pid])
            repaired.append({"project": pid, "to": videos[pid], "cards": len(cards)})
    return repaired
