# -*- coding: utf-8 -*-
"""
Карточки Anki через AnkiConnect (дополнение Anki, http://127.0.0.1:8765).

Карточки создаются в своей колоде (путь — settings.anki_deck манифеста, по
умолчанию "Claude::2. VIDEOS::<автор>::<видео>") с типом заметок из настроек
(anki_model; не задан – берётся из Anki: "Basic"/"Базовая" или первый
попавшийся, и запоминается). Первое поле типа – лицо, второе – оборот.
Существующие колоды не трогаются.

Лицо карточки: клип (проигрывается автоматически при открытии) и на новой
строке английский текст фрагмента. Оборот пока пустой — перевод добавится
позже. Клип вставляется тегом [sound:...]: так его играет и Anki на
компьютере (встроенный плеер mpv понимает H.265), и мобильные версии;
HTML-тег <video> в Anki на компьютере H.265/H.264 не показывает.

Своих полей под служебные данные у типа нет, поэтому код видео и номер фрагмента
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
from pathlib import Path

# Адрес можно подменить (для проверок с поддельным AnkiConnect).
ANKI_CONNECT_URL = os.environ.get("MEDIA_STUDY_ANKI_URL", "http://127.0.0.1:8765")
# Тип заметок и его поля – не постоянные: anki.MODEL_NAME, anki.FRONT_FIELD и
# anki.BACK_FIELD считаются при обращении (см. model() и __getattr__ ниже).
# Обычные имена типов "по умолчанию" в Anki на разных языках интерфейса.
BASIC_MODELS = ("Basic", "Базовая", "Основная", "Простая")
BASIC_STEMS = ("basic", "базов")
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


def _data_dir() -> Path:
    # Сервер и его фоновые процессы получают папку data через окружение.
    return Path(os.environ.get("MEDIA_STUDY_DATA_DIR") or Path(__file__).resolve().parents[2] / "data")


_model_cache: dict = {}  # {"name", "front", "back", "setting", "at"}
MODEL_CACHE_SECONDS = 10  # настройку могли поменять – перечитывается не чаще


def model() -> dict:
    """
    Тип заметок для карточек: {"name", "front", "back"}.

    Имя – из настроек (anki_model). Не задано – берётся из Anki: обычный
    "Basic" / "Базовая", если есть, иначе первый попавшийся – и записывается в
    настройки (дальше не меняется, пока его не поменяют там). Лицо – первое
    поле типа, оборот – второе. Anki закрыт, а тип ещё не известен –
    AnkiUnavailable.
    """
    import time

    from media_study.web import library

    if _model_cache and time.time() - _model_cache["at"] < MODEL_CACHE_SECONDS:
        return _model_cache
    data_dir = _data_dir()
    setting = (library.app_settings(data_dir).get("anki_model") or "").strip()
    if _model_cache and setting and _model_cache["setting"] == setting:
        _model_cache["at"] = time.time()
        return _model_cache
    name = setting
    names = invoke("modelNames")
    if not name:
        if not names:
            raise RuntimeError("в Anki нет ни одного типа заметок")
        # Обычный базовый тип; переименованный ("1.1 Базовый") – самый короткий
        # из похожих по названию; нет и такого – первый попавшийся.
        similar = sorted((n for n in names if any(stem in n.lower() for stem in BASIC_STEMS)), key=len)
        name = next((n for n in BASIC_MODELS if n in names), similar[0] if similar else names[0])
        if data_dir.is_dir():
            library.save_app_settings(data_dir, {"anki_model": name})
    elif name not in names:
        raise RuntimeError(f"в Anki нет типа заметок «{name}» (выберите другой в Настройках)")
    fields = invoke("modelFieldNames", modelName=name)
    if len(fields) < 2:
        raise RuntimeError(f"у типа заметок «{name}» меньше двух полей (нужны лицо и оборот)")
    _model_cache.update(name=name, front=fields[0], back=fields[1], setting=name, at=time.time())
    return _model_cache


def __getattr__(attr: str):
    # anki.MODEL_NAME / anki.FRONT_FIELD / anki.BACK_FIELD – по текущему типу заметок.
    key = {"MODEL_NAME": "name", "FRONT_FIELD": "front", "BACK_FIELD": "back"}.get(attr)
    if key is None:
        raise AttributeError(attr)
    return model()[key]


def ensure_model() -> None:
    model()  # нет типа из настроек / мало полей – RuntimeError с объяснением


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
    from media_study.core.manifest import UNVOICED_SPEAKERS

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
            "modelName": model()["name"],
            "fields": dict(zip((model()["front"], model()["back"]), decorate(front_html(media_name, text, with_clip=not unvoiced), back,
                                                                   speakers if _speakers_shown([f"{TAG}::{project}::{fragment_id}"], {}) else []))),
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
            front = card["fields"].get(model()["front"], {}).get("value", "")
            # Клип с лица могли удалить (реплика без озвучки) — это не ошибка.
            match = re.search(r"\[sound:[^\]]*\]", front)
            sound = match.group(0) if match else ""
            text = plain_front(front)
            result.append({
                "project": project,
                "fragment_id": fragment_id,
                "clip": sound.removeprefix("[sound:").removesuffix("]"),
                "text": text,
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
    invoke("updateNoteFields", note={"id": note_id, "fields": {model()["front"]: front_html(media_name, text, with_clip=not unvoiced)}})
    recolor_notes([note_id], speakers={note_id: speakers})
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
    Переводит карточки старого типа "media-study" на текущий тип заметок (те же
    заметки, их id и история повторений сохраняются). Возвращает, сколько.
    """
    if OLD_MODEL_NAME not in invoke("modelNames"):
        return 0
    ids = invoke("findNotes", query=f'"note:{OLD_MODEL_NAME}"')
    for note in invoke("notesInfo", notes=ids) if ids else []:
        fields = {name: value["value"] for name, value in note["fields"].items()}
        invoke("updateNoteModel", note={
            "id": note["noteId"],
            "modelName": model()["name"],
            "fields": {model()["front"]: f"{fields.get('Video', '')}<br>{fields.get('Text', '')}", model()["back"]: fields.get("Back", "")},
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
    others = invoke("cardsInfo", cards=invoke("findCards", query=f"is:new -tag:{TAG} -tag:{TAG}-rev prop:pos>={min(assigned)}"))
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


# -- цвета на карточках -----------------------------------------------------------
#
# Тип заметок может быть общим со всеми карточками пользователя – его
# стиль не трогаем; цвета ставятся прямо в поля карточек приложения
# (встроенный стиль у span с классом ms-…, по классу их потом находят и
# перекрашивают). Английское – светло-фиолетовое, русское (перевод, значения
# слов, пояснения – даже с английскими словами внутри) – бело-жёлтое, тире в
# разборе слов – серее, после всего содержимого карточки – говорящие серым
# (div.ms-who): в конце оборота, если перевод есть, иначе в конце лица
# (пустой оборот = "не переведено" для проверок перевода). Цвета – в
# настройках приложения (anki_color_*), "Перекрасить готовые" – recolor_all.

COLOR_DEFAULTS = {"en": "#c9b6ff", "ru": "#f6edcf", "dash": "#7d7d88", "who": "#8a8a95"}
# Служебные метки – не имена говорящих (говорящие хранятся метками, см. speaker_tag).
SERVICE_TAGS = {TAG_NO_TEXT, TAG_NO_SPEAKER, "агент_перевод", "leech", "marked"}

_MARK_SPAN = re.compile(r'<span class="ms-(?:en|ru|dash)"[^>]*>(.*?)</span>', re.S)
_WHO_DIV = re.compile(r'(?:<br\s*/?>\s*)?<div class="ms-who"[^>]*>(.*?)</div>', re.S)
_BREAKS = re.compile(r"(<br\s*/?>|</?ul>|</?li>|</?div[^>]*>)", re.I)


def card_colors() -> dict:
    """Цвета из настроек приложения (data/settings.json), по умолчанию – COLOR_DEFAULTS."""
    try:
        from pathlib import Path

        from media_study.web.library import app_settings

        settings = app_settings(Path(os.environ.get("MEDIA_STUDY_DATA_DIR", "data")))
        return {k: (settings.get(f"anki_color_{k}") or v) for k, v in COLOR_DEFAULTS.items()}
    except Exception:
        return dict(COLOR_DEFAULTS)


def _plain(fragment: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", fragment or "")).strip()


def unmark(field: str) -> tuple[str, str]:
    """Поле без разметки цветов и без строки говорящих; (поле, говорящие из неё)."""
    who = ""
    match = _WHO_DIV.search(field or "")
    if match:
        who = _plain(match.group(1))
    field = _WHO_DIV.sub("", field or "")
    while True:
        cleaned = _MARK_SPAN.sub(r"\1", field)
        if cleaned == field:
            return field, who
        field = cleaned


def plain_front(front: str) -> str:
    """Текст лица карточки (без клипа, цветов и строки говорящих), строками."""
    field, _ = unmark(front)
    field = re.sub(r"\[sound:[^\]]*\]", "", field)
    parts = [_plain(p) for p in _BREAKS.split(field) if not _BREAKS.fullmatch(p or "")]
    return "\n".join(p for p in parts if p)


def _span(kind: str, color: str, inner: str) -> str:
    return f'<span class="ms-{kind}" style="color:{color}">{inner}</span>'


def _paint_front(front: str, c: dict) -> str:
    parts = _BREAKS.split(front)
    out = []
    for part in parts:
        if _BREAKS.fullmatch(part or "") or not _plain(re.sub(r"\[sound:[^\]]*\]", "", part)):
            out.append(part)
            continue
        sound = re.match(r"\s*(\[sound:[^\]]*\])", part)
        if sound:
            out.append(sound.group(1) + _span("en", c["en"], part[sound.end():]))
        else:
            out.append(_span("en", c["en"], part))
    return "".join(out)


def _paint_back(back: str, c: dict) -> str:
    out = []
    for part in _BREAKS.split(back):
        if _BREAKS.fullmatch(part or "") or not _plain(part):
            out.append(part)
            continue
        # Разбор слова: "<i>phrase</i> – значение".
        term = re.match(r"^(\s*<i>.*?</i>)\s*[–-]\s*(.*)$", part, re.S)
        if term:
            out.append(_span("en", c["en"], term.group(1)) + " " + _span("dash", c["dash"], "–") + " " + _span("ru", c["ru"], term.group(2)))
        else:
            out.append(_span("ru", c["ru"], part))
    return "".join(out)


def speakers_from_tags(tags: list[str]) -> list[str]:
    return [t.replace("_", " ") for t in tags
            if t not in SERVICE_TAGS and not t.lower().startswith(TAG) and "::" not in t]


def decorate(front: str, back: str, speakers: list[str] | None = None, colors: dict | None = None) -> tuple[str, str]:
    """Поля карточки в цветах + строка говорящих в конце (см. выше)."""
    c = colors or card_colors()
    front, who_front = unmark(front)
    back, who_back = unmark(back)
    names = ", ".join(speakers) if speakers is not None else (who_back or who_front)
    has_back = bool(_plain(back))
    front = _paint_front(front, c)
    if has_back:
        back = _paint_back(back, c)
    if names:
        div = f'<div class="ms-who" style="color:{c["who"]}">{html.escape(names, quote=False)}</div>'
        if has_back:
            back += div
        else:
            front += div
    return front, back


def _speakers_shown(tags: list[str], cache: dict) -> bool:
    """
    Режим "говорящие" видео этой карточки (по метке media-study::<видео>::<фрагмент>):
    выключен – строки с именами на карточке нет (сами имена остаются в метках).
    """
    project = next((t.split("::")[1] for t in tags if t.lower().startswith(TAG + "::") and t.count("::") >= 2), None)
    if not project:
        return True
    if project not in cache:
        try:
            from media_study.web.library import show_speakers

            data_dir = Path(__file__).resolve().parents[2] / "data"
            cache[project] = show_speakers(data_dir / project)
        except Exception:  # нет такого видео и т.п. – как раньше, с именами
            cache[project] = True
    return cache[project]


def recolor_notes(note_ids: list[int], speakers: dict | None = None, colors: dict | None = None, progress=None) -> int:
    """
    Перекрасить карточки приложения (и поставить строку говорящих). speakers –
    {id заметки: [имена]} (иначе – из прежней строки или из меток). Видео с
    выключенным режимом "говорящие" – без строки имён.
    Возвращает, сколько заметок изменено.
    """
    c = colors or card_colors()
    shown: dict = {}
    changed = 0
    ids = list(note_ids)
    for start in range(0, len(ids), 100):
        for note in invoke("notesInfo", notes=ids[start:start + 100]):
            if TAG not in [t.lower() for t in note.get("tags", [])]:
                continue  # только карточки приложения
            front = note["fields"].get(model()["front"], {}).get("value", "")
            back = note["fields"].get(model()["back"], {}).get("value", "")
            names = (speakers or {}).get(note["noteId"])
            if names is None and not (unmark(front)[1] or unmark(back)[1]):
                names = speakers_from_tags(note.get("tags", []))
            if not _speakers_shown(note.get("tags", []), shown):
                names = []
            new_front, new_back = decorate(front, back, names, c)
            if (new_front, new_back) != (front, back):
                invoke("updateNoteFields", note={"id": note["noteId"], "fields": {model()["front"]: new_front, model()["back"]: new_back}})
                changed += 1
        if progress:
            progress(min(len(ids), start + 100), len(ids))
    return changed


def recolor_all(progress=None) -> int:
    """Все карточки приложения – в текущие цвета (кнопка в настройках)."""
    return recolor_notes(invoke("findNotes", query=f"tag:{TAG}"), progress=progress)
