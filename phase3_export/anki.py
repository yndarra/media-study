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
# Карточка фрагмента без текста (пауза, звуки) — тоже карточка, с этой меткой.
TAG_NO_TEXT = "без_текста"
# Текст есть, но у части реплик не определён говорящий (только для видео,
# где говорящие вообще известны — иначе метка была бы на всех карточках).
TAG_NO_SPEAKER = "без_автора"
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


def front_html(media_name: str, text: str, with_clip: bool = True) -> str:
    """
    Лицо: клип, под ним — текст фрагмента (у пустого фрагмента — только клип).
    with_clip=False — не озвученная реплика: только текст.
    """
    if not with_clip:
        return text_to_html(text)
    return f"[sound:{media_name}]<br>{text_to_html(text)}" if text.strip() else f"[sound:{media_name}]"


def note_tags(project: str, fragment_id: str, speakers: list[str] | None = None,
              no_text: bool = False, no_speaker: bool = False) -> list[str]:
    """Служебные метки приложения + говорящие персонажи + без_текста / без_автора."""
    tags = [TAG, f"{TAG}::{project}::{fragment_id}", *(speaker_tag(s) for s in speakers or [])]
    if no_text:
        tags.append(TAG_NO_TEXT)
    elif no_speaker:
        tags.append(TAG_NO_SPEAKER)
    return tags


def card_content(text: str, known_speakers: set[str] | None, unvoiced: bool = False) -> tuple[str, list[str], dict]:
    """
    Текст лица (без имён говорящих), говорящие и метки-признаки карточки
    (без_текста / без_автора) — общее для создания и обновления карточки.
    unvoiced — не озвученная реплика: над репликой молчащего героя остаётся
    подпись "Rover:" (видео нет — иначе непонятно, чья это реплика).
    """
    from common.manifest_schema import UNVOICED_SPEAKERS

    labeled = set(UNVOICED_SPEAKERS) if unvoiced else set()
    clean, speakers, anonymous = split_speakers_ex(text, known_speakers or set(), labeled)
    flags = {"no_text": not text.strip(), "no_speaker": bool(known_speakers) and anonymous}
    return clean, speakers, flags


def parse_tags(tags: list[str]) -> tuple[str, str]:
    """(код видео, фрагмент) из тега media-study::<видео>::<фрагмент>."""
    for tag in tags:
        parts = tag.split("::")
        if len(parts) == 3 and parts[0].lower() == TAG:
            return parts[1], parts[2]
    return "", ""


def add_clip_note(deck: str, clip_path, media_name: str, text: str, project: str, fragment_id: str, clip: str,
                  known_speakers: set[str] | None = None, back: str = "", extra_tags: list[str] | None = None,
                  unvoiced: bool = False) -> int:
    """
    Кладёт клип в медиа Anki и создаёт заметку. Имена говорящих из текста
    уходят в метки (split_speakers). unvoiced — карточка без клипа (только
    текст, с подписью "Rover:"). Возвращает id заметки.
    """
    text, speakers, flags = card_content(text, known_speakers, unvoiced)
    if not unvoiced:
        invoke("storeMediaFile", filename=media_name, path=str(clip_path))
    return invoke(
        "addNote",
        note={
            "deckName": deck,
            "modelName": MODEL_NAME,
            "fields": {FRONT_FIELD: front_html(media_name, text, with_clip=not unvoiced), BACK_FIELD: back},
            "tags": note_tags(project, fragment_id, speakers, **flags) + list(extra_tags or []),
            "options": {"allowDuplicate": False},
        },
    )


def flagged_notes() -> list[dict]:
    """
    Карточки приложения (с тегом media-study) с любым флагом — их пометили
    как недоработанные. Остальные карточки пользователя не смотрятся.
    """
    result = []
    # Синий (4) — пометка "карточка с Rover" (rover_flags.py), а не просьба о
    # доработке: такие карточки здесь не считаются.
    for flag in (1, 2, 3, 5, 6, 7):
        card_ids = invoke("findCards", query=f"tag:{TAG} flag:{flag}")
        if not card_ids:
            continue
        cards = invoke("cardsInfo", cards=card_ids)
        notes = {n["noteId"]: n for n in invoke("notesInfo", notes=list({c["note"] for c in cards}))}
        for card in cards:
            note = notes.get(card["note"], {})
            project, fragment_id = parse_tags(note.get("tags", []))
            front = card["fields"].get(FRONT_FIELD, {}).get("value", "")
            # Клип с лица могли удалить (реплика без озвучки) — это не ошибка.
            match = re.match(r"\s*(\[sound:[^\]]*\])(?:<br>)?", front)
            sound, text = (match.group(1), front[match.end():]) if match else ("", front)
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
                     project: str = "", fragment_id: str = "", known_speakers: set[str] | None = None,
                     unvoiced: bool = False) -> None:
    """
    Переделанный фрагмент: клип заменяется под тем же именем, текст карточки
    обновляется, флаг с её карточек снимается. История повторений сохраняется.
    """
    text, speakers, flags = card_content(text, known_speakers, unvoiced)
    if not unvoiced:
        invoke("storeMediaFile", filename=media_name, path=str(clip_path), deleteExisting=True)
    invoke("updateNoteFields", note={"id": note_id, "fields": {FRONT_FIELD: front_html(media_name, text, with_clip=not unvoiced)}})
    if project and fragment_id:
        invoke("updateNoteTags", note=note_id, tags=note_tags(project, fragment_id, speakers, **flags))
    # Обрезка/текст поправлены: оранжевый флаг снимается, красный ("и
    # обрезка, и перевод") становится зелёным — перевод ещё за агентом.
    cards = invoke("cardsInfo", cards=invoke("findCards", query=f"nid:{note_id}"))
    for card in cards:
        flag = card.get("flags", 0)
        new_flag = {1: 3, 2: 0}.get(flag, flag)
        if new_flag == flag:
            continue
        try:
            invoke("setSpecificValueOfCard", card=card["cardId"], keys=["flags"], newValues=[new_flag])
        except RuntimeError:
            pass  # не получилось — флаг поправится вручную


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
    """См. split_speakers_ex (без признака "есть реплики без говорящего")."""
    clean, speakers, _ = split_speakers_ex(text, known)
    return clean, speakers


def speaker_groups(text: str, known: set[str]) -> list[tuple[str | None, str]]:
    """Реплики фрагмента по порядку: [(говорящий или None, текст реплики)] — как строки карточки."""
    if not known:
        return [(None, line) for line in text.split("\n") if line.strip()]
    names = "|".join(re.escape(n) for n in sorted(known, key=len, reverse=True))
    marker = re.compile(rf"(?:^|(?<=\s))({names}):\s*")
    groups: list[list] = []
    for line in text.split("\n"):
        pos = 0
        for match in marker.finditer(line):
            before = line[pos:match.start()].strip()
            if before:
                if not groups:
                    groups.append([None, []])
                groups[-1][1].append(before)
            name = match.group(1)
            if not groups or groups[-1][0] != name:
                groups.append([name, []])
            pos = match.end()
        rest = line[pos:].strip()
        if rest:
            if not groups:
                groups.append([None, []])
            groups[-1][1].append(rest)
    return [(name, " ".join(parts)) for name, parts in groups if parts]


def text_from_card(card_text: str, fragment_text: str, known: set[str]) -> str:
    """
    Текст фрагмента из (поправленного в Anki) текста карточки: строки карточки —
    реплики, имена говорящих берутся из фрагмента ("Имя: реплика"). Число
    строк изменилось — имена по порядку, лишним строкам — без имени.
    """
    groups = speaker_groups(fragment_text, known)
    lines = [line.strip() for line in card_text.split("\n") if line.strip()]
    out = []
    for k, line in enumerate(lines):
        name = groups[k][0] if k < len(groups) else None
        out.append(f"{name}: {line}" if name else line)
    return "\n".join(out)


def split_speakers_ex(text: str, known: set[str], labeled: set[str] | None = None) -> tuple[str, list[str], bool]:
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
        return text, [], bool(text.strip())
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
    # labeled — у этих говорящих имя остаётся отдельной строкой над репликой.
    lines = [(f"{name}:\n" if name in (labeled or ()) else "") + " ".join(parts) for name, parts in groups if parts]
    anonymous = any(name is None and parts for name, parts in groups)
    return "\n".join(lines), speakers, anonymous


# -- порядок карточек ---------------------------------------------------------------

def delete_notes(note_ids: list[int]) -> None:
    """Удаляет карточки приложения (только свои — по id из index.json)."""
    if note_ids:
        invoke("deleteNotes", notes=note_ids)


def _longest_increasing(cards: list[dict]) -> set[int]:
    """
    Индексы карточек, которые уже стоят по порядку (самая длинная строго
    возрастающая по позиции цепочка) — их позиции можно не менять.
    """
    import bisect

    tails, tail_index, parent = [], [], [-1] * len(cards)
    for k, card in enumerate(cards):
        pos = bisect.bisect_left(tails, card["due"])
        if pos == len(tails):
            tails.append(card["due"])
            tail_index.append(k)
        else:
            tails[pos] = card["due"]
            tail_index[pos] = k
        parent[k] = tail_index[pos - 1] if pos else -1
    result, k = set(), tail_index[-1] if tail_index else -1
    while k != -1:
        result.add(k)
        k = parent[k]
    return result


def resequence(note_ids: list[int], dry_run: bool = False) -> int:
    """
    Новые (ещё не изучавшиеся) карточки заметок note_ids встают по порядку
    списка подряд, начиная с наименьшей их текущей позиции: вставка в
    середину сдвигает все последующие, дублей позиций нет. Изучавшиеся
    карточки (у них не позиция, а срок повторения) не трогаются.

    Если в нужном диапазоне позиций оказались новые карточки других колод,
    они (и все чужие после них) сдвигаются дальше с сохранением их порядка.
    Возвращает, сколько карточек получили новую позицию.
    """
    if not note_ids:
        return 0
    cards = []
    for chunk_start in range(0, len(note_ids), 500):
        chunk = note_ids[chunk_start: chunk_start + 500]
        query = "nid:" + ",".join(str(n) for n in chunk)
        cards += invoke("cardsInfo", cards=invoke("findCards", query=f"{query} is:new"))
    order = {note_id: k for k, note_id in enumerate(note_ids)}
    cards = sorted((c for c in cards if c["note"] in order), key=lambda c: (order[c["note"]], c["ord"]))
    if not cards:
        return 0
    # Минимум перестановок: карточка, стоящая по порядку, остаётся на своей
    # позиции (дыры от уже изучаемых карточек не "уплотняются"). Карточка не
    # на своём месте (новая — Anki ставит её в конец; её позиция больше, чем у
    # следующей по порядку) встаёт сразу за предыдущей, а следующие за ней
    # сдвигаются на одну, пока сдвиг не упрётся в свободную позицию.
    in_place = _longest_increasing(cards)
    assigned = []
    previous = None
    for k, card in enumerate(cards):
        due = card["due"]
        if previous is not None and (k not in in_place or due <= previous):
            due = previous + 1
        assigned.append(due)
        previous = due
    updates = [(c["cardId"], due) for c, due in zip(cards, assigned) if c["due"] != due]
    # Новая карточка другой колоды на той же позиции, что наша, — дубль: такие
    # чужие (и все чужие после них) сдвигаются за наш блок, их порядок сохраняется.
    ours = {c["cardId"] for c in cards}
    taken = set(assigned)
    others = invoke("cardsInfo", cards=invoke("findCards", query=f"is:new -tag:{TAG} prop:pos>={min(assigned)}"))
    others = sorted((c for c in others if c["cardId"] not in ours), key=lambda c: c["due"])
    clash = next((c for c in others if c["due"] in taken), None)
    if clash:
        delta = max(assigned) + 1 - clash["due"]
        updates += [(c["cardId"], c["due"] + delta) for c in others if c["due"] >= clash["due"]]
    if dry_run:
        return len(updates)
    for chunk_start in range(0, len(updates), 200):
        invoke("multi", actions=[
            {"action": "setSpecificValueOfCard",
             "params": {"card": card_id, "keys": ["due"], "newValues": [due], "warning_check": True}}
            for card_id, due in updates[chunk_start: chunk_start + 200]
        ])
    return len(updates)
