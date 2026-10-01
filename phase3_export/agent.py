# -*- coding: utf-8 -*-
"""
Агент перевода (OpenRouter): карточки Anki с флагом "перевод" и перевод целого
видео. Сам перевод — пачками по сцене с полным текстом видео (translator.py).

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

Запуск: py -3.12 -m phase3_export.agent --data-dir data [--project <код видео>] [--batch] [--limit N]
(без --project — карточки с флагом "перевод" всех видео).
"""
import argparse
import html
import json
import os
import re
import sys
import time
from pathlib import Path

from . import anki

TRANSLATION_FLAGS = (1, 3)
AGENT_TAG = "агент_перевод"
PROPOSALS_FILE = "agent_proposals.json"
STATUS_FILE = "agent_status.json"
DEFAULT_MODEL = "google/gemini-3.8-flash"
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


BATCH_JOBS_FILE = "agent_batches.json"  # заявки OpenRouter Batch API, ждущие ответа


def _status_writer(data_dir: Path, model: str, label: str):
    import os

    def write(**fields):
        # pid — чтобы перевод можно было остановить из приложения.
        save_json(data_dir / STATUS_FILE, {"state": "running", "label": label, "model": model, "pid": os.getpid(),
                                           "updated": time.time(), **fields})
    return write


def run(data_dir: Path, project: str | None = None, batch: bool = False, only_flagged: bool = False,
        limit: int | None = None) -> None:
    """
    Перевод пачками (translator.py).
      - project: перевести целое видео — все фрагменты без перевода; результат
        пишется сразу (переданным в Anki — на оборот, остальным — в хранилище);
      - иначе: карточки с флагом "перевод" всех видео — результат идёт в
        предложения (окно "Перевод": посмотреть, поправить, одобрить).
    batch — одной заявкой OpenRouter Batch API (ответ подтянется позже, см. poll_batches).
    """
    from webapp.library import app_settings

    from . import translator

    model = app_settings(data_dir).get("openrouter_model") or DEFAULT_MODEL
    proposals_path = data_dir / PROPOSALS_FILE
    pending = {p["note_id"] for p in load_json(proposals_path, [])}
    projects = [data_dir / project] if project else sorted(
        d for d in data_dir.iterdir() if (d / "export" / "index.json").exists())
    direct = bool(project)
    spent = 0.0
    status = _status_writer(data_dir, model, "перевод видео" if direct else "перевод по флагам")
    try:
        for project_dir in projects:
            if direct:
                cards = translator.project_cards(project_dir)
            else:
                cards = [c for c in translator.cards_to_translate(project_dir, only_flagged=True)
                         if c["note_id"] not in pending]
            if limit:
                cards = cards[:limit]
            if not cards:
                continue
            if batch:
                job = translator.submit_batch(data_dir, project_dir, cards, model)
                job["direct"] = direct
                jobs = load_json(data_dir / BATCH_JOBS_FILE, [])
                jobs.append(job)
                save_json(data_dir / BATCH_JOBS_FILE, jobs)
                print(f"{project_dir.name}: заявка {job['id']} — {len(cards)} карточек", flush=True)
                continue
            # Каждая пачка записывается сразу: целое видео — в Anki/хранилище,
            # по флагам — в предложения.
            from webapp.library import add_cost

            def spent_on(part, kind):
                # Расход пачки — по видео её карточек (у предложения – своя доля).
                for project_id in {p["project"] for p in part}:
                    add_cost(data_dir / project_id, kind, sum(p.get("cost", 0) for p in part if p["project"] == project_id))

            if direct:
                def on_batch(part, pd=project_dir, cs=cards):
                    translator.apply_direct(pd, part, cs)
                    spent_on(part, "translate")
            else:
                def on_batch(part):
                    save_json(proposals_path, load_json(proposals_path, []) + part)
                    spent_on(part, "retranslate")
            new, cost = translator.translate_realtime(data_dir, project_dir, cards, model,
                                                      lambda **kw: status(project=project_dir.name, **kw),
                                                      on_batch=on_batch)
            spent += cost
            print(f"{project_dir.name}: {len(new)} переводов (${cost:.4f})", flush=True)
    except Exception as error:  # сеть, баланс, модель — показать в окне "Перевод"
        save_json(data_dir / STATUS_FILE, {"state": "error", "message": str(error)[:300], "model": model,
                                           "spent": round(spent, 4), "updated": time.time()})
        raise
    save_json(data_dir / STATUS_FILE, {"state": "idle", "model": model, "spent": round(spent, 4), "updated": time.time()})


def poll_batches(data_dir: Path) -> int:
    """Готовые заявки Batch API: целое видео — сразу записать, по флагам — в предложения."""
    from . import translator

    jobs = load_json(data_dir / BATCH_JOBS_FILE, [])
    if not jobs:
        return 0
    left, added = [], 0
    for job in jobs:
        try:
            state, new, cost = translator.collect_batch(data_dir, job)
        except Exception:
            left.append(job)
            continue
        if state == "completed":
            from webapp.library import add_cost

            add_cost(data_dir / job["project"], "translate" if job.get("direct") else "retranslate", cost)
            if job.get("direct"):
                translator.apply_direct(data_dir / job["project"], new, job["cards"])
            else:
                save_json(data_dir / PROPOSALS_FILE, load_json(data_dir / PROPOSALS_FILE, []) + new)
            added += len(new)
        elif state in ("failed", "expired", "cancelled"):
            continue
        else:
            job["state"] = state
            left.append(job)
    save_json(data_dir / BATCH_JOBS_FILE, left)
    return added


def prune_stale(data_dir: Path) -> list[dict]:
    """
    Предложения по карточкам, с которых флаг "перевод" уже сняли (или которых
    уже нет), не нужны — убираются. Если Anki закрыт — список как есть.
    """
    proposals_path = data_dir / PROPOSALS_FILE
    proposals = load_json(proposals_path, [])
    if not proposals:
        return proposals
    try:
        flagged = set()
        for flag in TRANSLATION_FLAGS:
            card_ids = anki.invoke("findCards", query=f"tag:{anki.TAG} flag:{flag}")
            flagged |= {c["note"] for c in anki.invoke("cardsInfo", cards=card_ids)} if card_ids else set()
    except (anki.AnkiUnavailable, RuntimeError):
        return proposals
    # Предложения по флагу — пока флаг стоит; переводы целого видео (без флага) — всегда.
    kept = [p for p in proposals if not p.get("flag") or p["note_id"] in flagged]
    if len(kept) != len(proposals):
        save_json(proposals_path, kept)
    return kept


def apply(data_dir: Path, approve: list[int], reject: list[int], edits: dict | None = None) -> dict:
    """
    Одобренные предложения — в Anki (лицо без комментариев, новый оборот,
    метка агент_перевод; флаг "перевод" снимается: зелёный -> без флага,
    красный -> оранжевый). Отклонённые — просто убираются из списка.
    """
    proposals_path = data_dir / PROPOSALS_FILE
    proposals = load_json(proposals_path, [])
    approve, reject = set(approve), set(reject)
    # Оборот, поправленный вручную в окне "Перевод" перед одобрением.
    for p in proposals:
        edited = (edits or {}).get(str(p["note_id"]))
        if edited is not None:
            p["back_new"] = edited
    done = []
    for p in proposals:
        if p["note_id"] not in approve:
            continue
        # Этап 4 (перевод) — вся карточка: длинное тире "—" -> короткое "–" (и лицо, и оборот).
        anki.invoke("updateNoteFields", note={"id": p["note_id"], "fields": {
            anki.FRONT_FIELD: p["front_new"].replace("—", "–"), anki.BACK_FIELD: p["back_new"].replace("—", "–")}})
        anki.invoke("addTags", notes=[p["note_id"]], tags=AGENT_TAG)
        if p.get("flag"):  # перевод по флагу: зелёный снимается, красный -> оранжевый
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
    parser.add_argument("--project", default=None, help="Перевести непереведённые карточки этого видео")
    parser.add_argument("--batch", action="store_true", help="Одной заявкой Batch API (вдвое дешевле, позже)")
    args = parser.parse_args()
    data_dir = Path(args.data_dir)
    run(data_dir, project=args.project, batch=args.batch, only_flagged=not args.project, limit=args.limit)


if __name__ == "__main__":
    main()
