# -*- coding: utf-8 -*-
"""
ИИ-доводка фрагментов, которым не нашлось реплики в источнике.

После сверки с источником (source_text.py) у части фрагментов текст остаётся
"на слух" (распознанная речь): в источнике их реплики нет. В таком тексте
бывают ошибки распознавания – особенно в именах и терминах ("Soy Soy" вместо
"Suisui"). Здесь такие фрагменты небольшими пачками отдаются модели вместе с:
  - соседними фрагментами (по 2 с каждой стороны) – их текст уже сверен с
    источником, это контекст: кто говорит, о чём сцена;
  - словарём терминов группы (data/glossary/<автор>.json – тот же, что у
    перевода) и именами говорящих из источника.
Модель исправляет только явные ошибки распознавания, имена и термины
(по словарю и контексту). Говорящего не дописывает (угадать его по
контексту ненадёжно – для этого в редакторе буфер имён), не перефразирует и
ничего не добавляет от себя. Фрагмент остаётся с отметкой "проверить" (needs_review),
в review_note – что было на слух.

Модель – из настроек (openrouter_model, та же дешёвая, что для перевода);
расход пишется в project.json как "fix" (строка "Потрачено" в окне видео).
"""
from __future__ import annotations

import json
from pathlib import Path

from media_study.core.text_clean import clean_text

BATCH = 25  # фрагментов в запросе
CONTEXT = 2  # соседних фрагментов с каждой стороны
MARK = "в источнике не найдено"  # начало review_note у фрагментов "на слух" (source_text.py)

PROMPT = """Ты исправляешь распознанную речь (ASR) в субтитрах видео (обычно – сюжет игры). Для каждого фрагмента из списка «fix» текст записан на слух и может содержать ошибки распознавания: искажённые имена, названия, термины, похожие по звучанию слова.

Правила:
- исправляй ТОЛЬКО явные ошибки распознавания: имена и термины – по словарю и по контексту (соседние фрагменты уже сверены с источником и написаны правильно), похожие по звучанию слова, которые не подходят по смыслу;
- не перефразируй, не сокращай, не добавляй слов от себя, не меняй стиль и пунктуацию без нужды; если ошибок нет – верни текст как есть;
- строки вида «Имя: реплика» сохраняй как есть; если говорящего нет – НЕ добавляй его (угадывать нельзя);
- переносы строк (несколько говорящих) сохраняй.

Ответ – только JSON: {"fixed": {"<id>": "<исправленный текст>", ...}} – для каждого id из «fix»."""


def _targets(fragments) -> list[int]:
    """Фрагменты "на слух" со словами (музыка 🎵, "..." и т.п. – не в счёт)."""
    import re

    return [i for i, f in enumerate(fragments)
            if f.needs_review and (f.review_note or "").startswith(MARK)
            and len(re.findall(r"[A-Za-z]{2,}", f.text)) >= 1 and "🎵" not in f.text]


def _context(fragments, i: int) -> dict:
    """Соседи фрагмента с текстом (по CONTEXT с каждой стороны)."""
    before, after = [], []
    k = i - 1
    while k >= 0 and len(before) < CONTEXT:
        if fragments[k].text.strip():
            before.insert(0, fragments[k].text)
        k -= 1
    k = i + 1
    while k < len(fragments) and len(after) < CONTEXT:
        if fragments[k].text.strip():
            after.append(fragments[k].text)
        k += 1
    return {"before": before, "after": after}


def _speakers(project_dir: Path) -> list[str]:
    """Имена говорящих из источника (transcript.txt), по частоте."""
    path = Path(project_dir) / "transcript.txt"
    if not path.exists():
        return []
    counts: dict[str, int] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if ": " in line:
            name = line.split(": ", 1)[0].strip()
            if 0 < len(name) <= 40:
                counts[name] = counts.get(name, 0) + 1
    return [n for n, _ in sorted(counts.items(), key=lambda kv: -kv[1])][:80]


def fix_unmatched(project_dir: Path, manifest, log=print) -> int:
    """Довести фрагменты "на слух" моделью. Возвращает, сколько текстов изменилось."""
    from media_study.export.translator import _post, load_glossary, parse_answer
    from media_study.web.library import add_cost, app_settings

    project_dir = Path(project_dir)
    data_dir = project_dir.parent
    fragments = manifest.fragments
    targets = _targets(fragments)
    if not targets:
        return 0
    model = app_settings(data_dir).get("openrouter_model") or "google/gemini-3.8-flash"
    glossary = sorted(load_glossary(data_dir, project_dir))[:400]
    speakers = _speakers(project_dir)
    log(f"ИИ-доводка: фрагментов на слух {len(targets)} (модель {model})")
    changed = 0
    spent = 0.0
    for start in range(0, len(targets), BATCH):
        part = targets[start:start + BATCH]
        items = [{"id": str(i), "text": fragments[i].text, **_context(fragments, i)} for i in part]
        user = (f"Словарь терминов: {', '.join(glossary) or '—'}\n"
                f"Говорящие в источнике: {', '.join(speakers) or '—'}\n\n"
                "fix (before/after – соседние фрагменты, уже верные):\n" + json.dumps(items, ensure_ascii=False, indent=1))
        # Рассуждения – коротко: иначе модель часами думает о точке после 🎵 и
        # упирается в лимит, не дав ответа.
        body = {"model": model, "temperature": 0.1, "max_tokens": 4000 + 150 * len(part), "usage": {"include": True},
                "response_format": {"type": "json_object"}, "reasoning": {"effort": "low"},
                "messages": [{"role": "system", "content": PROMPT}, {"role": "user", "content": user}]}
        try:
            reply = _post(data_dir, "/chat/completions", body)
            answer = parse_answer(reply["choices"][0]["message"]["content"])
        except Exception as error:  # сеть, баланс – остаётся текст на слух
            log(f"  ИИ-доводка не удалась: {error}")
            break
        spent += float((reply.get("usage") or {}).get("cost") or 0)
        for key, text in (answer.get("fixed") or {}).items():
            try:
                i = int(key)
            except (TypeError, ValueError):
                continue
            text = _drop_new_speakers(fragments[i].text, clean_text(text))
            if i not in part or not text or text == fragments[i].text:
                continue
            f = fragments[i]
            # Слишком сильное расхождение – модель не исправила, а переписала: не берём.
            if not _close_enough(f.text, text):
                continue
            f.review_note = f"текст на слух поправлен ИИ (было: {f.text})"[:500]
            f.text = text
            f.original_text = text
            # Весь текст по-прежнему "на слух" (голубой в редакторе) – проверить.
            f.heard_ranges = [[0, len(text)]]
            changed += 1
    add_cost(project_dir, "fix", spent)
    log(f"  ИИ-доводка: исправлено {changed} из {len(targets)} (${spent:.4f})")
    return changed


def speaker_prefix_len(line: str) -> int:
    """Длина "Имя: " в начале строки (как в редакторе: до первого ":", не больше 3 слов), 0 – нет."""
    head, sep, _ = line.partition(":")
    if not sep or not head.strip() or len(head.split()) > 3:
        return 0
    return len(head) + 1


def _drop_new_speakers(old: str, new: str) -> str:
    """Говорящий, которого не было на слух, – убирается (строки сравниваются по порядку)."""
    old_lines, new_lines = old.split("\n"), new.split("\n")
    if len(old_lines) != len(new_lines):
        return new
    out = []
    for o, n in zip(old_lines, new_lines):
        if not speaker_prefix_len(o) and speaker_prefix_len(n):
            n = n[speaker_prefix_len(n):].lstrip()
        out.append(n)
    return "\n".join(out)


def _close_enough(old: str, new: str) -> bool:
    """Исправление, а не другой текст: похожесть по символам не ниже 0.6."""
    from rapidfuzz import fuzz

    strip = lambda t: "\n".join(l.split(": ", 1)[-1] for l in t.split("\n")).lower()
    return fuzz.ratio(strip(old), strip(new)) >= 60
