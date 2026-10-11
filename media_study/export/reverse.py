# -*- coding: utf-8 -*-
"""
Обратные карточки: на лице – перевод, на обороте – клип и оригинал.

Включаются в настройках (отдельно для видео и аудио: reverse_cards_video /
reverse_cards_audio). Тип заметок прямых карточек (из настроек) не
меняется: у обратных свой тип «media-study (обратная)» с теми же двумя
полями и стилем, скопированным с него, – шаблон просто меняет стороны
местами. Обратная заметка:
  - создаётся, когда у прямой карточки есть перевод (иначе нечего показать
    на лице), в той же колоде, по порядку – сразу за прямой;
  - повторяет поля прямой (правка, новый перевод, перекраска – обновляются);
  - удаляется вместе с прямой (worker._drop_orphans);
  - метки – свои (media-study-rev, media-study-rev::<видео>::<фрагмент>), без
    общей media-study: проверка флагов, счётчики и перевод их не видят.
Выключили настройку – новые не создаются, уже созданные остаются (их история
повторений не теряется).
"""
from __future__ import annotations

from pathlib import Path

from . import anki

REV_MODEL = "media-study (обратная)"
REV_TAG = "media-study-rev"


def enabled(project_dir: Path) -> bool:
    from media_study.web.library import app_settings, video_info

    project_dir = Path(project_dir)
    kind = "audio" if video_info(project_dir).get("audio_only") else "video"
    return bool(app_settings(project_dir.parent).get(f"reverse_cards_{kind}"))


def ensure_model() -> None:
    """Тип заметок для обратных карточек – если его ещё нет (стиль – как у основного)."""
    if REV_MODEL in anki.invoke("modelNames"):
        return
    try:
        css = anki.invoke("modelStyling", modelName=anki.MODEL_NAME).get("css", "")
    except RuntimeError:
        css = ""
    anki.invoke("createModel", modelName=REV_MODEL, inOrderFields=[anki.FRONT_FIELD, anki.BACK_FIELD], css=css,
                isCloze=False, cardTemplates=[{
                    "Name": "Обратная",
                    "Front": "{{" + anki.BACK_FIELD + "}}",
                    "Back": "{{FrontSide}}\n\n<hr id=answer>\n\n{{" + anki.FRONT_FIELD + "}}",
                }])


def _plain(html: str) -> str:
    return anki._plain(anki.unmark(html)[0]) if html else ""


def sync_project(project_dir: Path, log=print, force: bool = False) -> int:
    """
    Обратные карточки видео – по прямым (создать недостающие, обновить
    изменившиеся). force – и при выключенной настройке (не используется по
    умолчанию). Возвращает, сколько заметок создано или обновлено.
    Anki закрыт – AnkiUnavailable.
    """
    from media_study.export.worker import default_deck, read_json, write_json

    project_dir = Path(project_dir)
    if not force and not enabled(project_dir):
        return 0
    index_path = project_dir / "export" / "index.json"
    index = read_json(index_path, [])
    entries = [e for e in index if e.get("anki_note_id")]
    if not entries:
        return 0
    ensure_model()
    forward = {}
    ids = [e["anki_note_id"] for e in entries]
    for start in range(0, len(ids), 200):
        for note in anki.invoke("notesInfo", notes=ids[start:start + 200]):
            if note:
                forward[note["noteId"]] = note
    rev_ids = [e["anki_rev_note_id"] for e in entries if e.get("anki_rev_note_id")]
    existing = {}
    for start in range(0, len(rev_ids), 200):
        for note in anki.invoke("notesInfo", notes=rev_ids[start:start + 200]):
            if note:
                existing[note["noteId"]] = note
    changed = created = 0
    for e in entries:
        note = forward.get(e["anki_note_id"])
        if not note:
            continue
        front = note["fields"].get(anki.FRONT_FIELD, {}).get("value", "")
        back = note["fields"].get(anki.BACK_FIELD, {}).get("value", "")
        if not _plain(back).strip():
            continue  # перевода ещё нет – на лице обратной показать нечего
        rev = existing.get(e.get("anki_rev_note_id"))
        fields = {anki.FRONT_FIELD: front, anki.BACK_FIELD: back}
        if rev:
            if any(rev["fields"].get(k, {}).get("value", "") != v for k, v in fields.items()):
                anki.invoke("updateNoteFields", note={"id": rev["noteId"], "fields": fields})
                changed += 1
            continue
        deck = e.get("anki_deck") or default_deck(project_dir)
        anki.ensure_deck(deck)
        e["anki_rev_note_id"] = anki.invoke("addNote", note={
            "deckName": deck, "modelName": REV_MODEL, "fields": fields,
            "tags": [REV_TAG, f"{REV_TAG}::{project_dir.name}::{e['fragment_id']}"],
            "options": {"allowDuplicate": True},
        })
        created += 1
    if created:
        write_json(index_path, index)
        # Новые обратные – сразу за своими прямыми (порядок новых карточек).
        anki.resequence(ordered_notes(project_dir, index))
    if created or changed:
        log(f"{project_dir.name}: обратные карточки – создано {created}, обновлено {changed}")
    return created + changed


def ordered_notes(project_dir: Path, index: list[dict]) -> list[int]:
    """Заметки видео по порядку фрагментов: прямая, за ней её обратная."""
    from media_study.core.manifest import Manifest

    manifest = Manifest.load(Path(project_dir) / "manifest.json")
    start = {f.id: f.algo_start_frame for f in manifest.fragments}
    out = []
    for e in sorted((e for e in index if e.get("anki_note_id")),
                    key=lambda e: (start.get(e["fragment_id"], e.get("start_frame", 0)), e["clip"])):
        out.append(e["anki_note_id"])
        if e.get("anki_rev_note_id"):
            out.append(e["anki_rev_note_id"])
    return out


def sync_all(data_dir: Path, log=print) -> int:
    """Все видео (после перекраски, включения настройки)."""
    total = 0
    for project in sorted(Path(data_dir).iterdir()):
        if (project / "manifest.json").exists() and (project / "export" / "index.json").exists():
            try:
                total += sync_project(project, log=log)
            except RuntimeError as error:
                if isinstance(error, anki.AnkiUnavailable):
                    raise
                log(f"{project.name}: обратные карточки не синхронизированы ({error})")
    return total
