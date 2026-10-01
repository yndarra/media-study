# -*- coding: utf-8 -*-
"""
Карточки Anki через AnkiConnect (дополнение Anki, http://127.0.0.1:8765).

Карточки создаются в своей колоде (путь — settings.anki_deck манифеста, по
умолчанию "Claude::2. VIDEOS::<автор>::<видео>") с обычным типом заметок
пользователя "1.0 Левобережье" (поля "Лицо" и "Оборот"), как и все его
карточки. Существующие колоды не трогаются.

Лицо карточки: клип (проигрывается автоматически при открытии) и на новой
строке английский текст фрагмента. Оборот пока пустой — перевод добавится
позже. Клип вставляется тегом [sound:...]: так его играет и Anki на
компьютере (встроенный плеер mpv понимает H.265), и мобильные версии;
HTML-тег <video> в Anki на компьютере H.265/H.264 не показывает.

Своих полей у "Левобережья" нет, поэтому код видео и номер фрагмента
хранятся в теге media-study::<код видео>::<фрагмент> (плюс общий тег
media-study) — по нему проверка флагов находит, какой фрагмент вернуть на
правку, и обновляет эту же карточку на её месте. Имя файла клипа в Anki
уникально: <код видео>_<номер клипа>.mp4 (у всех колод одна папка медиа).
"""
import html
import json
import os
import re
import urllib.request

# Адрес можно подменить (для проверок с поддельным AnkiConnect).
ANKI_CONNECT_URL = os.environ.get("MEDIA_STUDY_ANKI_URL", "http://127.0.0.1:8765")
MODEL_NAME = "1.0 Левобережье"
FRONT_FIELD = "Лицо"
BACK_FIELD = "Оборот"
TAG = "media-study"
# Тип заметок, которым приложение пользовалось раньше, — его карточки
# переводятся на MODEL_NAME (migrate_old_notes).
OLD_MODEL_NAME = "media-study"


class AnkiUnavailable(RuntimeError):
    """Anki не запущен или AnkiConnect не отвечает — карточки создадутся позже."""


def invoke(action: str, **params):
    payload = json.dumps({"action": action, "version": 6, "params": params}).encode("utf-8")
    request = urllib.request.Request(ANKI_CONNECT_URL, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            reply = json.loads(response.read().decode("utf-8"))
    except OSError as error:
        raise AnkiUnavailable(f"Anki не отвечает ({error})") from error
    if reply.get("error"):
        raise RuntimeError(f"AnkiConnect {action}: {reply['error']}")
    return reply.get("result")


def ensure_model() -> None:
    if MODEL_NAME not in invoke("modelNames"):
        raise RuntimeError(f"в Anki нет типа заметок «{MODEL_NAME}»")


def ensure_deck(deck: str) -> None:
    # createDeck ничего не делает, если колода уже есть.
    invoke("createDeck", deck=deck)


def text_to_html(text: str) -> str:
    return "<br>".join(html.escape(line, quote=False) for line in text.split("\n"))


def front_html(media_name: str, text: str) -> str:
    """Лицо: клип, под ним — текст фрагмента."""
    return f"[sound:{media_name}]<br>{text_to_html(text)}"


def note_tags(project: str, fragment_id: str, speakers: list[str] | None = None) -> list[str]:
    """Служебные метки приложения + говорящие персонажи карточки."""
    return [TAG, f"{TAG}::{project}::{fragment_id}", *(speaker_tag(s) for s in speakers or [])]


def parse_tags(tags: list[str]) -> tuple[str, str]:
    """(код видео, фрагмент) из тега media-study::<видео>::<фрагмент>."""
    for tag in tags:
        parts = tag.split("::")
        if len(parts) == 3 and parts[0].lower() == TAG:
            return parts[1], parts[2]
    return "", ""


def add_clip_note(deck: str, clip_path, media_name: str, text: str, project: str, fragment_id: str, clip: str,
                  known_speakers: set[str] | None = None) -> int:
    """
    Кладёт клип в медиа Anki и создаёт заметку. Имена говорящих из текста
    уходят в метки (split_speakers). Возвращает id заметки.
    """
    text, speakers = split_speakers(text, known_speakers or set())
    invoke("storeMediaFile", filename=media_name, path=str(clip_path))
    return invoke(
        "addNote",
        note={
            "deckName": deck,
            "modelName": MODEL_NAME,
            "fields": {FRONT_FIELD: front_html(media_name, text), BACK_FIELD: ""},
            "tags": note_tags(project, fragment_id, speakers),
            "options": {"allowDuplicate": False},
        },
    )


def flagged_notes() -> list[dict]:
    """
    Карточки приложения (с тегом media-study) с любым флагом — их пометили
    как недоработанные. Остальные карточки пользователя не смотрятся.
    """
    result = []
    for flag in range(1, 8):
        card_ids = invoke("findCards", query=f"tag:{TAG} flag:{flag}")
        if not card_ids:
            continue
        cards = invoke("cardsInfo", cards=card_ids)
        notes = {n["noteId"]: n for n in invoke("notesInfo", notes=list({c["note"] for c in cards}))}
        for card in cards:
            note = notes.get(card["note"], {})
            project, fragment_id = parse_tags(note.get("tags", []))
            front = card["fields"].get(FRONT_FIELD, {}).get("value", "")
            sound, _, text = front.partition("<br>")
            result.append({
                "project": project,
                "fragment_id": fragment_id,
                "clip": sound.removeprefix("[sound:").removesuffix("]"),
                "text": html.unescape(text.replace("<br>", "\n")),
                "deck": card.get("deckName", ""),
                "flag": flag,
                "card_id": card["cardId"],
                "note_id": card["note"],
            })
    return result


def update_clip_note(note_id: int, clip_path, media_name: str, text: str,
                     project: str = "", fragment_id: str = "", known_speakers: set[str] | None = None) -> None:
    """
    Переделанный фрагмент: клип заменяется под тем же именем, текст карточки
    обновляется, флаг с её карточек снимается. История повторений сохраняется.
    """
    text, speakers = split_speakers(text, known_speakers or set())
    invoke("storeMediaFile", filename=media_name, path=str(clip_path), deleteExisting=True)
    invoke("updateNoteFields", note={"id": note_id, "fields": {FRONT_FIELD: front_html(media_name, text)}})
    if project and fragment_id:
        invoke("updateNoteTags", note=note_id, tags=note_tags(project, fragment_id, speakers))
    for card_id in invoke("findCards", query=f"nid:{note_id}"):
        try:
            invoke("setSpecificValueOfCard", card=card_id, keys=["flags"], newValues=[0])
        except RuntimeError:
            pass  # не получилось — флаг снимется вручную


def migrate_old_notes() -> int:
    """
    Переводит карточки старого типа "media-study" на "1.0 Левобережье" (те же
    заметки, их id и история повторений сохраняются). Возвращает, сколько.
    """
    if OLD_MODEL_NAME not in invoke("modelNames"):
        return 0
    ids = invoke("findNotes", query=f'"note:{OLD_MODEL_NAME}"')
    for note in invoke("notesInfo", notes=ids) if ids else []:
        fields = {name: value["value"] for name, value in note["fields"].items()}
        invoke("updateNoteModel", note={
            "id": note["noteId"],
            "modelName": MODEL_NAME,
            "fields": {FRONT_FIELD: f"{fields.get('Video', '')}<br>{fields.get('Text', '')}", BACK_FIELD: fields.get("Back", "")},
            "tags": note_tags(fields.get("Project", ""), fields.get("Fragment", "")),
        })
    return len(ids)


# -- говорящие: из текста — в метки -------------------------------------------------

def speaker_tag(name: str) -> str:
    """Метка Anki не может содержать пробелов — "Elder Exile" -> "Elder_Exile"."""
    return "_".join(name.split())


def split_speakers(text: str, known: set[str]) -> tuple[str, list[str]]:
    """
    Текст карточки без имён говорящих и сами говорящие (для меток).

    Имя считается говорящим, только если оно есть в known (говорящие из
    источника этого видео) — иначе "Lesson One: CPR!" дал бы персонажа
    "Lesson One". Имена убираются где угодно в строке (после правок в одной
    строке бывает "Yangyang: ... Yangyang: ..."). Подряд идущие реплики одного
    персонажа склеиваются в одну строку, строки без имени продолжают реплику
    перед ними; новый персонаж — новая строка.
    """
    if not known:
        return text, []
    names = "|".join(re.escape(n) for n in sorted(known, key=len, reverse=True))
    marker = re.compile(rf"(?:^|(?<=\s))({names}):\s*")
    groups: list[list] = []  # [говорящий, [куски текста]]
    speakers: list[str] = []
    for line in text.split("\n"):
        pos = 0
        for match in marker.finditer(line):
            before = line[pos:match.start()].strip()
            if before:
                # Текст до имени — продолжение предыдущей реплики.
                if not groups:
                    groups.append([None, []])
                groups[-1][1].append(before)
            name = match.group(1)
            if name not in speakers:
                speakers.append(name)
            if not groups or groups[-1][0] != name:
                groups.append([name, []])
            pos = match.end()
        rest = line[pos:].strip()
        if rest:
            if not groups:
                groups.append([None, []])
            groups[-1][1].append(rest)
    lines = [" ".join(parts) for _, parts in groups if parts]
    return "\n".join(lines), speakers
