# -*- coding: utf-8 -*-
"""
Перевод карточек видео пачками по сцене (OpenRouter).

Зачем пачками: перевод сильно зависит от контекста (кто говорит, что было до
и после, кто такие персонажи и что значат термины). Поэтому модель
переводит сразу пачку подряд идущих карточек (BATCH_SIZE) и в каждом
запросе видит ВЕСЬ текст видео с именами говорящих. Текст видео один и тот
же во всех запросах — он помечается для кэша (cache_control), и со второго
запроса читается из кэша примерно за 10% цены.

Словарь терминов (data/glossary/<автор>.json) — одни и те же имена и
термины переводятся одинаково и внутри видео, и между видео одного автора
(например, всеми актами сюжета игры). Модель дополняет словарь новыми
терминами.

Режимы:
  - сразу (realtime): пачки по очереди, с кэшем;
  - пакетом (OpenRouter Batch API): все пачки одной заявкой, вдвое дешевле,
    результат — когда будет готов (обычно минуты, максимум 24 часа); кэша нет.

Результат — предложения (agent.py: data/agent_proposals.json), их одобряют
в окне "Перевод"; в Anki ничего не пишется без одобрения.
"""
import html
import json
import re
import time
import urllib.request
from datetime import datetime
from pathlib import Path

from . import anki
from .agent import (DEFAULT_MODEL, PROPOSALS_FILE, STATUS_FILE, _key, extract_comments, front_text, load_json,
                    render_back, save_json)

BATCH_SIZE = 40
MAX_ATTEMPTS = 3  # повторы пачки, если ответ модели не разобрался
API = "https://openrouter.ai/api/v1"

SYSTEM_PROMPT = """Ты – профессиональный литературный переводчик с английского на русский и составитель учебных карточек Anki. Пользователь учит английский по репликам из видео (сюжет игры, ролики). Твоя задача – перевести пачку подряд идущих реплик и для каждой собрать материал для оборота карточки.

ВХОД
1. Полный текст видео – все реплики по порядку с именами говорящих. Номер #NNNN перед репликой – номер карточки. Это контекст: кто говорит, к кому, что было до и что будет после, кто эти персонажи и что значат термины мира.
2. Словарь терминов – уже выбранные переводы имён и терминов. Следуй ему.
3. Пачка карточек для перевода: номер и реплика (строки «Имя: текст»; на самой карточке имён нет); иногда – текущий перевод на карточке и комментарии пользователя.

ЧТО ВЕРНУТЬ – только JSON:
{"cards": [{"id": "0123", "translation": "...", "alternatives": [], "terms": [{"phrase": "...", "meaning": "..."}], "literal": null, "explanation": null}],
 "glossary": [{"term": "...", "translation": "..."}]}
Карточек в ответе ровно столько, сколько в пачке, с теми же id.

ОБОРОТ КАРТОЧКИ СОСТОИТ ИЗ ЧАСТЕЙ (порядок фиксирован, программа соберёт его сама):
1. translation – перевод реплики. Естественный живой русский, как в хорошей локализации: передай смысл, интонацию, характер и манеру речи говорящего (Chixia – бойкая и простая, Yangyang – мягкая и вежливая, и т.п.), учитывай сцену. Не калькируй английский порядок слов. Если на карточке несколько строк (разные говорящие) – перевод из стольких же строк через \\n в том же порядке, без имён.
2. alternatives – другие переводы. Только если фразу действительно часто переводят по-разному и полезно знать оба варианта (идиома, двусмысленность, разный регистр). Максимум один-два. В большинстве карточек – пустой список.
3. terms – сложные слова и выражения, идиомы, фразовые глаголы, слова в переносном значении, характерный сленг. phrase – ровно как в английском тексте (форма может быть словарной, если так понятнее), meaning – перевод и, если нужно, короткое пояснение в скобках. Пример: phrase "trope", meaning "образное выражение, троп (узнаваемый «оборот» – тема, сюжетный ход, структура, типаж персонажа или мотив, который часто используется авторами для построения историй)". Цель – разбор примерно в половине карточек: в каждой реплике ищи то, что полезно ученику уровня B1–B2 – фразовые глаголы (lure out, tie up, come running), идиомы и устойчивые обороты (hook, line, and sinker; lead the pack; no-go), разговорные формы и сокращения (gonna, ya, til, Bet), слова в переносном значении, менее частые слова (stationed, run-of-the-mill), характерные конструкции (Madam Magistrate's information aside). Если в реплике такого нет – terms пустой; совсем простые слова (harbor, strong, doubt) не добавляй; одно и то же выражение не повторяй в соседних карточках без нужды.
4. literal – буквальный перевод, только для реплик в переносном значении, когда он помогает понять, как устроена фраза. Редко. Иначе null. Пример для "Is this a mind-reading gathering?": "Это что, собрание по чтению мыслей?"
5. explanation – пояснение реалий, лора, культурного контекста, отсылок, игры слов – если без него смысл неясен. Иногда. Иначе null. Пример: "«Китайский дракон», также известный как Лун, – легендарное существо китайской мифологии, фольклора и культуры в целом."

ЖЁСТКИЕ ПРАВИЛА
- Тире – только короткое «–» (en dash), никогда «—».
- Имена собственные и уникальные термины мира игры (персонажи, места, организации, явления: Rover, Baizhi, Jinzhou, Norfall Barrens, Midnight Rangers, Tacet Discord, Resonator, Etheric Sea) пиши латиницей как в оригинале – целиком, и в переводе, и в пояснениях, – если словарь не указывает иное.
- Обычные слова, должности и обращения – переводи по-русски, даже если в игре они с большой буквы: Academy – Академия, Madam Magistrate – госпожа Магистрат, Magistrate – Магистрат, General – генерал, City Hall – ратуша. Никогда не смешивай языки внутри одного названия и не оставляй английское обычное слово в русской фразе («у входа в Academy», «госпожа Magistrate» – нельзя).
- В словаре (glossary) – как именно пишется название в переводе: латиницей («Baizhi – не переводится») или по-русски («Academy – Академия»).
- Ничего не пиши о технической стороне (строки, паузы, субтитры, карточки, номера).
- Комментарии пользователя к карточке (вопросы, просьбы вроде «поясни за слово gathering») выполни – обычно это значит добавить слово в terms и/или explanation; сами комментарии в ответ не переноси.
- Если на карточке уже есть перевод – улучши его с учётом комментариев, а не переписывай без причины.
- glossary – только НОВЫЕ имена и термины мира, которых нет в словаре, с выбранным переводом (или пометкой «не переводится»)."""


def _glossary_path(data_dir: Path, project_dir: Path) -> Path:
    from webapp.library import group_of

    name = re.sub(r"[^\w\- ]+", "_", group_of(project_dir)).strip() or "общий"
    return Path(data_dir) / "glossary" / f"{name}.json"


def load_glossary(data_dir: Path, project_dir: Path) -> dict:
    return load_json(_glossary_path(data_dir, project_dir), {})


def merge_glossary(data_dir: Path, project_dir: Path, new_terms: list) -> None:
    path = _glossary_path(data_dir, project_dir)
    glossary = load_json(path, {})
    for item in new_terms or []:
        if isinstance(item, dict) and item.get("term") and item["term"] not in glossary:
            glossary[item["term"]] = str(item.get("translation") or "").replace("—", "–")
    path.parent.mkdir(parents=True, exist_ok=True)
    save_json(path, glossary)


# -- что переводить ----------------------------------------------------------------

def video_transcript(project_dir: Path, number_all: bool = False) -> tuple[str, dict]:
    """
    Полный текст видео для контекста ("#NNNN Имя: реплика", по порядку) и
    {id фрагмента: номер карточки}. Номер — номер клипа в export/index.json;
    number_all — номер каждого фрагмента по порядку в редакторе (для видео,
    которые ещё не в Anki: эксперименты с переводом).
    """
    from common.manifest_schema import Manifest, STATUS_ACTIVE
    from webapp.library import title_of
    from .worker import read_json

    manifest = Manifest.load(project_dir / "manifest.json")
    if number_all:
        number = {f.id: f"{k + 1:04d}" for k, f in enumerate(manifest.fragments)}
    else:
        index = read_json(project_dir / "export" / "index.json", [])
        number = {e["fragment_id"]: e["clip"].split(".")[0] for e in index}
    lines = [f"Видео: {title_of(project_dir)}", ""]
    for fragment in manifest.fragments:
        if fragment.status != STATUS_ACTIVE or not fragment.text.strip():
            continue
        tag = f"#{number[fragment.id]}" if fragment.id in number else "#----"
        for k, line in enumerate(fragment.text.split("\n")):
            lines.append(f"{tag if k == 0 else '     '} {line}")
    return "\n".join(lines), number


def cards_to_translate(project_dir: Path, only_flagged: bool = False, fragment_ids: set | None = None) -> list[dict]:
    """
    Карточки видео в Anki, которым нужен перевод: без оборота (или все с
    флагом "перевод", если only_flagged), по порядку видео.
    """
    from common.manifest_schema import Manifest
    from .worker import read_json

    manifest = Manifest.load(project_dir / "manifest.json")
    order = {f.id: k for k, f in enumerate(manifest.fragments)}
    texts = {f.id: f.text for f in manifest.fragments}
    index = [e for e in read_json(project_dir / "export" / "index.json", []) if e.get("anki_note_id")]
    if fragment_ids is not None:
        index = [e for e in index if e["fragment_id"] in fragment_ids]
    index.sort(key=lambda e: order.get(e["fragment_id"], 10 ** 9))
    if not index:
        return []
    notes = {n["noteId"]: n for n in anki.invoke("notesInfo", notes=[e["anki_note_id"] for e in index])}
    flags = {}
    if only_flagged:
        for flag in (1, 3):
            ids = anki.invoke("findCards", query=f'"tag:{anki.TAG}::{project_dir.name}::*" flag:{flag}')
            for card in anki.invoke("cardsInfo", cards=ids) if ids else []:
                flags[card["note"]] = flag
    result = []
    for entry in index:
        note = notes.get(entry["anki_note_id"])
        if not note:
            continue
        front = note["fields"][anki.FRONT_FIELD]["value"]
        back = note["fields"][anki.BACK_FIELD]["value"]
        front_clean, c1 = extract_comments(front)
        back_clean, c2 = extract_comments(back)
        if only_flagged and note["noteId"] not in flags:
            continue
        if not only_flagged and fragment_ids is None and front_text(back_clean).strip():
            continue  # уже переведена
        if not texts.get(entry["fragment_id"], "").strip():
            continue  # без текста — переводить нечего
        result.append({
            # Номер — как в тексте видео для модели (порядок фрагментов в редакторе).
            "id": f"{order[entry['fragment_id']] + 1:04d}", "note_id": note["noteId"], "fragment_id": entry["fragment_id"],
            "flag": flags.get(note["noteId"], 0), "project": project_dir.name,
            "front_old": front, "back_old": back, "front_new": front_clean,
            "text": front_text(front_clean), "speaker_text": texts.get(entry["fragment_id"], ""),
            "back_text": front_text(back_clean), "comments": c1 + c2,
        })
    return result


# -- запросы -------------------------------------------------------------------------

def _batch_prompt(cards: list[dict], glossary: dict) -> str:
    parts = ["СЛОВАРЬ ТЕРМИНОВ:"]
    parts += [f"- {term} – {translation}" for term, translation in glossary.items()] or ["(пока пуст)"]
    parts += ["", f"ПАЧКА ДЛЯ ПЕРЕВОДА ({len(cards)} карточек):"]
    for card in cards:
        # Реплика с именами говорящих (на карточке — тот же текст без имён).
        parts.append(f"\n#{card['id']}\n{card['speaker_text'] or card['text']}")
        if card["back_text"]:
            parts.append(f"Текущий перевод на карточке: {card['back_text']}")
        if card["comments"]:
            parts.append("Комментарии пользователя: " + "; ".join(card["comments"]))
    return "\n".join(parts)


def request_body(model: str, transcript: str, cards: list[dict], glossary: dict) -> dict:
    """Тело запроса chat/completions: правила и текст видео — с пометкой для кэша."""
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": "ПОЛНЫЙ ТЕКСТ ВИДЕО:\n" + transcript, "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": _batch_prompt(cards, glossary)},
            ]},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.3,
        "max_tokens": 400 * len(cards) + 600,
        "usage": {"include": True},
    }


def _switch_to_next_key(data_dir: Path) -> bool:
    """Кончились деньги на основном ключе — запасной становится основным (если он есть)."""
    from webapp.library import app_settings, save_app_settings

    settings = app_settings(data_dir)
    nxt = settings.get("openrouter_key_file_next") or ""
    if not nxt or not Path(nxt).exists():
        return False
    save_app_settings(data_dir, {"openrouter_key_file": nxt, "openrouter_key_file_next": ""})
    print("Ключ OpenRouter: деньги кончились — перехожу на запасной ключ", flush=True)
    return True


def _post(data_dir: Path, path: str, body: dict | None = None, method: str = "POST") -> dict:
    import urllib.error

    for attempt in range(2):
        request = urllib.request.Request(
            API + path, method=method,
            data=json.dumps(body).encode("utf-8") if body is not None else None,
            headers={"Authorization": f"Bearer {_key(data_dir)}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            # 402 — на ключе нет денег: тот же запрос — с запасным ключом.
            if error.code == 402 and attempt == 0 and _switch_to_next_key(data_dir):
                continue
            raise


def parse_answer(content: str | None) -> dict:
    # Пустой ответ (бывает у провайдера, например сразу после смены ключа) —
    # такая же ошибка разбора, как битый JSON: пачка повторится.
    if not content:
        raise ValueError("пустой ответ модели")
    match = re.search(r"\{.*\}", content, re.S)
    return json.loads(match.group(0) if match else content)


def proposals_from(answer: dict, cards: list[dict], model: str, cost: float, batch_label: str) -> list[dict]:
    """Ответ модели на пачку -> предложения (по карточке), оборот — по правилам (render_back)."""
    by_id = {str(c.get("id", "")).lstrip("#"): c for c in answer.get("cards", []) if isinstance(c, dict)}
    now = datetime.now().isoformat(timespec="seconds")
    result = []
    for card in cards:
        part = by_id.get(card["id"])
        if not part or not str(part.get("translation") or "").strip():
            continue
        result.append({
            **{k: card[k] for k in ("note_id", "flag", "project", "fragment_id", "front_old", "back_old", "front_new",
                                    "comments", "text")},
            "card_number": card["id"], "back_new": render_back(part), "answer": part,
            "model": model, "cost": round(cost / max(1, len(cards)), 5), "batch": batch_label, "created": now,
        })
    return result


def chunks(items: list, size: int = BATCH_SIZE) -> list[list]:
    return [items[i: i + size] for i in range(0, len(items), size)]


def translate_realtime(data_dir: Path, project_dir: Path, cards: list[dict], model: str,
                       status=lambda **kw: None, transcript: str | None = None,
                       glossary: dict | None = None, on_batch=None) -> tuple[list[dict], float]:
    """
    Пачки по очереди (с кэшем текста видео). Возвращает (предложения, стоимость $).
    transcript / glossary — свои (для экспериментов): словарь тогда ведётся
    в памяти и в data/glossary не пишется. on_batch(предложения пачки) —
    вызывается после каждой пачки (запись сразу, а не в конце: прерванный
    перевод не теряет сделанного, полоса "Переведено" растёт по ходу).
    """
    if transcript is None:
        transcript, _ = video_transcript(project_dir, number_all=True)
    proposals, spent = [], 0.0
    groups = chunks(cards)
    for n, group in enumerate(groups, 1):
        status(done=n - 1, total=len(groups), spent=round(spent, 4))
        terms = glossary if glossary is not None else load_glossary(data_dir, project_dir)
        # Модель изредка возвращает битый JSON (пропущена запятая и т.п.) — пачка повторяется.
        for attempt in range(MAX_ATTEMPTS):
            reply = _post(data_dir, "/chat/completions", request_body(model, transcript, group, terms))
            cost = float((reply.get("usage") or {}).get("cost") or 0)
            spent += cost
            try:
                answer = parse_answer(reply["choices"][0]["message"]["content"])
                break
            except (ValueError, KeyError, IndexError, TypeError):
                if attempt == MAX_ATTEMPTS - 1:
                    raise
                print(f"пачка {group[0]['id']}–{group[-1]['id']}: ответ не разобрался, повторяю", flush=True)
        if glossary is not None:
            for item in answer.get("glossary") or []:
                if isinstance(item, dict) and item.get("term"):
                    glossary.setdefault(item["term"], str(item.get("translation") or ""))
        else:
            merge_glossary(data_dir, project_dir, answer.get("glossary"))
        batch_proposals = proposals_from(answer, group, model, cost, f"{project_dir.name}:{group[0]['id']}-{group[-1]['id']}")
        proposals += batch_proposals
        if on_batch:
            on_batch(batch_proposals)
    status(done=len(groups), total=len(groups), spent=round(spent, 4))
    return proposals, spent


def submit_batch(data_dir: Path, project_dir: Path, cards: list[dict], model: str) -> dict:
    """Все пачки одной заявкой OpenRouter Batch API (вдвое дешевле, ответ — позже)."""
    transcript, _ = video_transcript(project_dir, number_all=True)
    glossary = load_glossary(data_dir, project_dir)
    groups = chunks(cards)
    requests = []
    for group in groups:
        body = request_body(model, transcript, group, glossary)
        body.pop("model")
        body.pop("usage", None)
        requests.append({"custom_id": f"{group[0]['id']}-{group[-1]['id']}", "body": body})
    reply = _post(data_dir, "/batches", {"endpoint": "/v1/chat/completions", "model": model, "requests": requests})
    return {"id": reply.get("id"), "model": model, "project": project_dir.name,
            "groups": [[c["id"] for c in g] for g in groups], "cards": cards, "submitted": time.time()}


def collect_batch(data_dir: Path, job: dict) -> tuple[str, list[dict], float]:
    """Проверить заявку: (статус, предложения если готово, стоимость)."""
    reply = _post(data_dir, f"/batches/{job['id']}", method="GET")
    state = reply.get("status", "")
    # Сколько пачек заявки уже готово — для полосы в "Сейчас идёт".
    counts = reply.get("request_counts") or {}
    job["done"], job["total"] = counts.get("completed", 0), counts.get("total", len(job.get("groups", [])))
    if state != "completed":
        return state, [], 0.0
    project_dir = Path(data_dir) / job["project"]
    by_card = {c["id"]: c for c in job["cards"]}
    proposals = []
    cost = float((reply.get("usage") or {}).get("cost") or 0)
    for item in reply.get("results") or []:
        response = item.get("response") or {}
        body = response.get("body", response)
        try:
            answer = parse_answer(body["choices"][0]["message"]["content"])
        except (KeyError, IndexError, ValueError, TypeError):
            continue
        first, last = item["custom_id"].split("-")
        group = [by_card[i] for i in next(g for g in job["groups"] if g[0] == first and g[-1] == last)]
        merge_glossary(data_dir, project_dir, answer.get("glossary"))
        proposals += proposals_from(answer, group, job["model"], cost / max(1, len(job["groups"])),
                                    f"{job['project']}:{first}-{last}")
    return state, proposals, cost


# -- перевод целого видео: сразу в Anki / в хранилище ---------------------------------
#
# Кнопка "Перевести" (подробности видео) переводит все фрагменты видео без
# перевода — и уже переданные в Anki, и ещё нет. Переданным перевод пишется
# сразу на оборот карточки; остальные — в хранилище export/translations.json
# (фрагмент -> текст, перевод): когда фрагмент передадут в Anki с тем же
# текстом, карточка сразу создаётся с переводом (worker.py).

TRANSLATIONS_FILE = "translations.json"
TRANSLATED_TAG = "агент_перевод"


def _translations_path(project_dir: Path) -> Path:
    return Path(project_dir) / "export" / TRANSLATIONS_FILE


def stored_translation(project_dir: Path, fragment_id: str, text: str) -> str:
    """Оборот, переведённый заранее для этого фрагмента (если текст тот же), иначе ""."""
    item = load_json(_translations_path(project_dir), {}).get(fragment_id)
    return item["back"] if item and item.get("text", "").strip() == (text or "").strip() else ""


def store_translations(project_dir: Path, items: list[dict]) -> None:
    path = _translations_path(project_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = load_json(path, {})
    for item in items:
        data[item["fragment_id"]] = {"text": item["speaker_text"], "back": item["back"], "model": item["model"],
                                     "created": datetime.now().isoformat(timespec="seconds")}
    save_json(path, data)


def project_cards(project_dir: Path) -> list[dict]:
    """
    Фрагменты видео с текстом, которым нужен перевод, по порядку: уже
    переданные в Anki (карточка создана) и без оборота. Ещё не переданные не
    переводятся — перевод идёт только по тому, что уже в Anki, и кончается,
    когда кончаются переданные. id — номер фрагмента в редакторе (как в
    тексте видео для модели).
    """
    from common.manifest_schema import Manifest, STATUS_ACTIVE
    from .worker import read_json

    manifest = Manifest.load(project_dir / "manifest.json")
    index = {e["fragment_id"]: e for e in read_json(project_dir / "export" / "index.json", []) if e.get("anki_note_id")}
    notes = {}
    if index:
        notes = {n["noteId"]: n for n in anki.invoke("notesInfo", notes=[e["anki_note_id"] for e in index.values()])}
    cards = []
    for k, f in enumerate(manifest.fragments):
        if f.status != STATUS_ACTIVE or not f.text.strip():
            continue
        plain = "\n".join(line.split(": ", 1)[1] if ": " in line else line for line in f.text.split("\n"))
        card = {"id": f"{k + 1:04d}", "note_id": None, "fragment_id": f.id, "flag": 0, "project": project_dir.name,
                "front_old": "", "back_old": "", "front_new": "", "text": plain, "speaker_text": f.text,
                "back_text": "", "comments": []}
        entry = index.get(f.id)
        if entry:
            note = notes.get(entry["anki_note_id"])
            if not note:
                continue
            back = note["fields"][anki.BACK_FIELD]["value"]
            if front_text(extract_comments(back)[0]).strip():
                continue  # уже переведена в Anki
            card.update(note_id=note["noteId"], front_old=note["fields"][anki.FRONT_FIELD]["value"])
        else:
            continue  # ещё не в Anki — переводится после передачи
        cards.append(card)
    return cards


def in_anki_text_count(project_dir: Path) -> int:
    """Сколько живых фрагментов с текстом уже в Anki (карточка создана)."""
    from common.manifest_schema import Manifest, STATUS_ACTIVE
    from .worker import read_json

    manifest = Manifest.load(project_dir / "manifest.json")
    with_note = {e["fragment_id"] for e in read_json(project_dir / "export" / "index.json", []) if e.get("anki_note_id")}
    return sum(1 for f in manifest.fragments if f.status == STATUS_ACTIVE and f.text.strip() and f.id in with_note)


def apply_direct(project_dir: Path, proposals: list[dict], cards: list[dict]) -> int:
    """
    Перевод целого видео: переданным в Anki — сразу на оборот (метка
    агент_перевод, короткое тире на всей карточке), остальным — в хранилище.
    """
    by_fragment = {c["fragment_id"]: c for c in cards}
    stored = []
    for p in proposals:
        card = by_fragment[p["fragment_id"]]
        stored.append({**card, "back": p["back_new"], "model": p["model"]})
        if card["note_id"]:
            anki.invoke("updateNoteFields", note={"id": card["note_id"], "fields": {
                anki.FRONT_FIELD: card["front_old"].replace("—", "–"), anki.BACK_FIELD: p["back_new"].replace("—", "–")}})
            anki.invoke("addTags", notes=[card["note_id"]], tags=TRANSLATED_TAG)
    store_translations(project_dir, stored)
    return len(stored)
