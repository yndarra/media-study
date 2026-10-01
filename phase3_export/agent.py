# -*- coding: utf-8 -*-
"""
Агент перевода (OpenRouter) для карточек Anki с флагом "перевод".

Флаги карточек приложения в Anki:
  1 красный  — править и обрезку/текст, и перевод;
  2 оранжевый ("жёлтый") — обрезку/текст (возврат на этап 2, см. редактор);
  3 зелёный  — перевод: его делает этот агент.

Пользователь пишет в карточке комментарии со звёздочкой ("*поясни за слово
gathering") — агент учитывает их и убирает из карточки. Агент НЕ меняет
карточки сам: он готовит предложения (data/agent_proposals.json), их
просматривают в приложении (что на что заменено) и одобряют/отклоняют.
Одобренное записывается в Anki, карточка получает метку агент_перевод, флаг
"перевод" снимается (красный становится оранжевым — обрезка ещё впереди).

Оборот карточки собирается строго по правилам (модель отдаёт только части):
  1. перевод;
  2. другие переводы — маркированный список (редко);
  3. пустая строка (если дальше что-то есть);
  4. сложные слова/выражения: "<i>trope</i> – образное выражение, ..." (тире –);
  5. пустая строка;
  6. буквальный перевод: "... – буквальный перевод" (редко);
  7. пустая строка;
  8. пояснения (иногда).

Запуск: py -3.12 -m phase3_export.agent --data-dir data [--limit N]
"""
import argparse
import html
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

from . import anki

TRANSLATION_FLAGS = (1, 3)
AGENT_TAG = "агент_перевод"
PROPOSALS_FILE = "agent_proposals.json"
STATUS_FILE = "agent_status.json"
DEFAULT_MODEL = "anthropic/claude-sonnet-5.5"
CONTEXT_BEFORE = 4
CONTEXT_AFTER = 2

SYSTEM_PROMPT = """Ты переводишь реплики из видео (сюжет игры/ролика) с английского на русский для карточек Anki. Пользователь учит английский.

Верни ТОЛЬКО JSON:
{"translation": "...", "alternatives": ["..."], "terms": [{"phrase": "...", "meaning": "..."}], "literal": "...", "explanation": "..."}

Правила:
- translation — естественный литературный перевод реплики с учётом контекста сцены (кто говорит, что было до и после). Если в реплике несколько строк (разные говорящие), перевод — столько же строк через \\n, в том же порядке.
- alternatives — другие переводы, ТОЛЬКО если фразу реально часто переводят по-разному и полезно знать оба варианта. Обычно пусто [].
- terms — сложные слова/выражения и слова в переносном значении из реплики: phrase — как в английском тексте, meaning — перевод и, если нужно, короткое пояснение в скобках. Например phrase "trope", meaning "образное выражение, троп (узнаваемый «оборот» – тема, сюжетный ход, типаж персонажа или мотив, который часто используется авторами)". Встречается довольно часто, но далеко не в каждой карточке; простые слова не добавляй.
- literal — буквальный перевод, только если реплика в переносном значении и буквальный перевод помогает понять её устройство. Редко. Иначе null.
- explanation — пояснение реалий/лора/культурного контекста, если оно реально нужно (иногда). Иначе null.
- Используй короткое тире – (en dash), НИКОГДА не длинное —.
- Имена и названия из игры не переводи и не транслитерируй — ни в переводе, ни в пояснениях (Jinzhou, Rover, Baizhi, Chixia, Tacet Discord и т.п.), пиши их латиницей как в оригинале.
- Не пиши ничего о технической стороне (разбивка на строки, паузы, субтитры, карточка) — только о языке и смысле сцены.
- alternatives — максимум один-два варианта и только когда это действительно распространённое расхождение переводов; в большинстве карточек пусто.
- Если пользователь оставил комментарии (вопросы, просьбы), выполни их: например "поясни за слово gathering" – добавь gathering в terms (и при необходимости explanation). Сами комментарии в ответ не переноси."""


def _key(data_dir: Path) -> str:
    """Ключ OpenRouter: переменная OPENROUTER_API_KEY или файл из настроек (data/settings.json)."""
    from webapp.library import app_settings

    if os.environ.get("OPENROUTER_API_KEY"):
        return os.environ["OPENROUTER_API_KEY"].strip()
    key_file = app_settings(data_dir).get("openrouter_key_file") or ""
    if key_file and Path(key_file).exists():
        return Path(key_file).read_text(encoding="utf-8").strip()
    raise RuntimeError("нет ключа OpenRouter: задайте файл ключа в Настройках или OPENROUTER_API_KEY")


# -- поля карточки: комментарии со звёздочкой ------------------------------------

_SEGMENT_SPLIT = re.compile(r"(<br\s*/?>|</?div[^>]*>|\n)", re.I)


def _plain(fragment_html: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", fragment_html)).strip()


def extract_comments(field_html: str) -> tuple[str, list[str]]:
    """
    Комментарии пользователя — куски поля (строки), начинающиеся со "*", и
    хвост строки после " *" ("Hello there *поясни за there"). Возвращает поле
    без них и сами комментарии.
    """
    comments = []
    parts = _SEGMENT_SPLIT.split(field_html or "")
    kept = []
    for part in parts:
        if _SEGMENT_SPLIT.fullmatch(part or ""):
            kept.append(part)
            continue
        text = _plain(part)
        if text.startswith("*"):
            comments.append(text.lstrip("*").strip())
            continue
        match = re.search(r"\s\*(?=\S)", part)
        if match and not part.strip().startswith("[sound:"):
            comments.append(_plain(part[match.end():]))
            part = part[: match.start()]
        kept.append(part)
    cleaned = "".join(kept)
    # Переносы строк, оставшиеся в конце от убранных комментариев.
    cleaned = re.sub(r"(\s*<br\s*/?>)+\s*$", "", cleaned)
    cleaned = re.sub(r"(<br\s*/?>\s*){3,}", "<br><br>", cleaned)
    return cleaned, [c for c in comments if c]


def front_text(front_html: str) -> str:
    """Английский текст лица карточки (без клипа)."""
    without_sound = re.sub(r"\[sound:[^\]]+\]", "", front_html)
    lines = [_plain(p) for p in _SEGMENT_SPLIT.split(without_sound) if not _SEGMENT_SPLIT.fullmatch(p or "")]
    return "\n".join(line for line in lines if line)


# -- оборот по правилам -----------------------------------------------------------

def _clean(text) -> str:
    return (str(text or "")).replace("—", "–").strip()


def render_back(answer: dict) -> str:
    """Оборот карточки из частей ответа модели — строго по правилам модуля."""
    esc = lambda t: html.escape(_clean(t), quote=False)
    translation = "<br>".join(esc(line) for line in _clean(answer.get("translation")).split("\n") if line.strip())
    sections = []
    first = translation
    alternatives = [a for a in (answer.get("alternatives") or []) if _clean(a)]
    if alternatives:
        first += "<ul>" + "".join(f"<li>{esc(a)}</li>" for a in alternatives) + "</ul>"
    sections.append(first)
    terms = [t for t in (answer.get("terms") or []) if isinstance(t, dict) and _clean(t.get("phrase")) and _clean(t.get("meaning"))]
    if terms:
        sections.append("<br>".join(f"<i>{esc(t['phrase'])}</i> – {esc(t['meaning'])}" for t in terms))
    if _clean(answer.get("literal")):
        literal = _clean(answer["literal"])
        if "буквальный перевод" not in literal:
            literal += " – буквальный перевод"
        sections.append(esc(literal))
    if _clean(answer.get("explanation")):
        sections.append(esc(answer["explanation"]))
    # Пустая строка между частями; после списка (<ul> — сам блок) — один перенос.
    out = sections[0]
    for section in sections[1:]:
        out += ("<br>" if out.endswith("</ul>") else "<br><br>") + section
    return out


# -- контекст сцены -------------------------------------------------------------

def scene_context(data_dir: Path, project: str, fragment_id: str) -> dict:
    """Название видео и соседние реплики (по порядку фрагментов) для перевода."""
    from common.manifest_schema import Manifest
    from webapp.library import title_of

    project_dir = data_dir / project
    manifest = Manifest.load(project_dir / "manifest.json")
    texts = [(f.id, f.text) for f in manifest.fragments if f.status == "active" and f.text.strip()]
    ids = [fid for fid, _ in texts]
    k = ids.index(fragment_id) if fragment_id in ids else -1
    before = [t for _, t in texts[max(0, k - CONTEXT_BEFORE): k]] if k >= 0 else []
    current = texts[k][1] if k >= 0 else ""
    after = [t for _, t in texts[k + 1: k + 1 + CONTEXT_AFTER]] if k >= 0 else []
    return {"title": title_of(project_dir), "before": before, "current": current, "after": after}


def ask_model(data_dir: Path, model: str, card: dict, context: dict) -> tuple[dict, float]:
    """Запрос к OpenRouter. Возвращает (ответ JSON, стоимость в $ если известна)."""
    user = (
        f"Видео: {context['title']}\n\n"
        "Что было до:\n" + ("\n".join(context["before"]) or "—") + "\n\n"
        "РЕПЛИКА (переводи её; с именами говорящих — для контекста):\n" + (context["current"] or card["text"]) + "\n\n"
        "Текст на карточке (без имён):\n" + card["text"] + "\n\n"
        "Что было после:\n" + ("\n".join(context["after"]) or "—") + "\n"
    )
    if card["back_text"]:
        user += "\nТекущий перевод на карточке (улучши его, учитывая комментарии):\n" + card["back_text"] + "\n"
    if card["comments"]:
        user += "\nКомментарии пользователя к карточке:\n" + "\n".join(f"- {c}" for c in card["comments"]) + "\n"
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}],
        "response_format": {"type": "json_object"},
        "temperature": 0.3,
        # Ответ короткий; без ограничения OpenRouter резервирует деньги под
        # максимальную длину ответа модели и при маленьком балансе отвечает 402.
        "max_tokens": 1200,
        "usage": {"include": True},
    }
    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {_key(data_dir)}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        reply = json.loads(response.read().decode("utf-8"))
    content = reply["choices"][0]["message"]["content"]
    match = re.search(r"\{.*\}", content, re.S)
    answer = json.loads(match.group(0) if match else content)
    return answer, float((reply.get("usage") or {}).get("cost") or 0)


# -- карточки с флагом "перевод" --------------------------------------------------

def translation_cards() -> list[dict]:
    """Карточки приложения с красным или зелёным флагом: поля, комментарии, где лежат."""
    cards = []
    for flag in TRANSLATION_FLAGS:
        card_ids = anki.invoke("findCards", query=f"tag:{anki.TAG} flag:{flag}")
        if not card_ids:
            continue
        infos = anki.invoke("cardsInfo", cards=card_ids)
        notes = {n["noteId"]: n for n in anki.invoke("notesInfo", notes=list({c["note"] for c in infos}))}
        for card in infos:
            note = notes[card["note"]]
            project, fragment_id = anki.parse_tags(note["tags"])
            front = note["fields"][anki.FRONT_FIELD]["value"]
            back = note["fields"][anki.BACK_FIELD]["value"]
            front_clean, front_comments = extract_comments(front)
            back_clean, back_comments = extract_comments(back)
            cards.append({
                "note_id": note["noteId"], "card_id": card["cardId"], "flag": flag,
                "project": project, "fragment_id": fragment_id, "deck": card.get("deckName", ""),
                "front_old": front, "back_old": back,
                "front_new": front_clean, "back_clean": back_clean,
                "text": front_text(front_clean),
                "back_text": front_text(back_clean),
                "comments": front_comments + back_comments,
            })
    return cards


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save_json(path: Path, data) -> None:
    from common.manifest_schema import replace_file

    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    replace_file(tmp, path)


def run(data_dir: Path, limit: int | None = None) -> None:
    """Готовит предложения для всех карточек с флагом "перевод", у которых их ещё нет."""
    from webapp.library import app_settings

    model = app_settings(data_dir).get("openrouter_model") or DEFAULT_MODEL
    proposals_path = data_dir / PROPOSALS_FILE
    status_path = data_dir / STATUS_FILE
    proposals = load_json(proposals_path, [])
    pending = {p["note_id"] for p in proposals}
    cards = [c for c in translation_cards() if c["note_id"] not in pending]
    if limit:
        cards = cards[:limit]
    spent = 0.0
    for n, card in enumerate(cards, 1):
        save_json(status_path, {"state": "running", "done": n - 1, "total": len(cards), "spent": round(spent, 4),
                                "model": model, "updated": time.time()})
        try:
            context = scene_context(data_dir, card["project"], card["fragment_id"])
            answer, cost = ask_model(data_dir, model, card, context)
        except Exception as error:  # сеть, баланс, модель — показать и идти дальше
            print(f"{card['project']} {card['fragment_id']}: ошибка — {error}", flush=True)
            save_json(status_path, {"state": "error", "message": str(error)[:300], "done": n - 1,
                                    "total": len(cards), "spent": round(spent, 4), "model": model, "updated": time.time()})
            if "402" in str(error) or "credit" in str(error).lower():
                return  # кончились деньги на ключе — дальше смысла нет
            continue
        spent += cost
        proposals.append({
            **{k: card[k] for k in ("note_id", "card_id", "flag", "project", "fragment_id", "deck",
                                    "front_old", "back_old", "front_new", "comments", "text")},
            "back_new": render_back(answer),
            "answer": answer,
            "model": model,
            "cost": round(cost, 5),
            "created": datetime.now().isoformat(timespec="seconds"),
        })
        save_json(proposals_path, proposals)
        print(f"{card['project']} {card['fragment_id']}: готово (${cost:.4f})", flush=True)
    save_json(status_path, {"state": "idle", "done": len(cards), "total": len(cards), "spent": round(spent, 4),
                            "model": model, "updated": time.time()})


def apply(data_dir: Path, approve: list[int], reject: list[int]) -> dict:
    """
    Одобренные предложения — в Anki (лицо без комментариев, новый оборот,
    метка агент_перевод; флаг "перевод" снимается: зелёный -> без флага,
    красный -> оранжевый). Отклонённые — просто убираются из списка.
    """
    proposals_path = data_dir / PROPOSALS_FILE
    proposals = load_json(proposals_path, [])
    approve, reject = set(approve), set(reject)
    done = []
    for p in proposals:
        if p["note_id"] not in approve:
            continue
        anki.invoke("updateNoteFields", note={"id": p["note_id"], "fields": {
            anki.FRONT_FIELD: p["front_new"], anki.BACK_FIELD: p["back_new"]}})
        anki.invoke("addTags", notes=[p["note_id"]], tags=AGENT_TAG)
        new_flag = 2 if p["flag"] == 1 else 0
        for card_id in anki.invoke("findCards", query=f"nid:{p['note_id']}"):
            anki.invoke("setSpecificValueOfCard", card=card_id, keys=["flags"], newValues=[new_flag])
        done.append(p["note_id"])
    left = [p for p in proposals if p["note_id"] not in approve and p["note_id"] not in reject]
    save_json(proposals_path, left)
    return {"applied": len(done), "rejected": len(reject), "left": len(left)}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Агент перевода карточек с флагом «перевод».")
    parser.add_argument("--data-dir", default="data")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()
    run(Path(args.data_dir), args.limit)


if __name__ == "__main__":
    main()
