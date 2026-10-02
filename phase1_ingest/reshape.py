# -*- coding: utf-8 -*-
"""
Доводка нарезки после сверки с источником (до оформления текста):

1. Фрагмент, в котором говорят два персонажа и более, делится на границе
   реплик: по времени первого слова реплики нового говорящего (по смыслу —
   реплики разных персонажей в разных карточках).
2. Фрагмент, кончающийся запятой (фразу разрезало посреди предложения), —
   склеивается со следующим, если тот идёт сразу за ним (без тишины-
   заполнителя), говорящий тот же (или у продолжения нет имени) и вместе не
   длиннее MERGE_MAX_SECONDS; первая буква продолжения становится строчной,
   если это не имя собственное.

Нужно у записей: start_frame/end_frame, text, source_segment_ids, и "_words"
— слова источника фрагмента вместе с индексом слова речи (см.
source_text.assign_source_words).
"""
from __future__ import annotations

import re

# Склейка на запятой: вместе — не длиннее этого (иначе карточка слишком длинная).
MERGE_MAX_SECONDS = 15.0
# Делить по говорящим — только если обе части не короче этого.
SPLIT_MIN_SECONDS = 0.6

_SPEAKER_RE = re.compile(r"^\s*([^:\n]{1,80}?)\s*:\s*")


def _speaker(line: str) -> str | None:
    m = _SPEAKER_RE.match(line or "")
    if not m or len(m.group(1).split()) > 3:
        return None
    return m.group(1).strip()


def split_by_speakers(entries: list[dict], asr_words: list[dict], fps: float, join) -> list[dict]:
    """Делит фрагменты с репликами нескольких говорящих (join — как source_text._join)."""
    result = []
    for entry in entries:
        words = entry.get("_words") or []
        speakers = {w.get("speaker") for w, _ in words if w.get("speaker")}
        if len(speakers) < 2 or entry.get("heard"):
            result.append(entry)
            continue
        # Где начинаются реплики нового говорящего (слово с новой строки).
        cuts = [k for k in range(1, len(words))
                if words[k][0].get("newline_before") and words[k][0].get("speaker")
                and words[k][0].get("speaker") != words[k - 1][0].get("speaker")]
        pieces, start = [], 0
        for cut in cuts + [len(words)]:
            pieces.append(words[start:cut])
            start = cut
        bounds = [entry["start_frame"]]
        for piece in pieces[1:]:
            seconds = asr_words[piece[0][1]].get("start", 0.0)
            bounds.append(max(bounds[-1] + 1, round(seconds * fps)))
        bounds.append(entry["end_frame"])
        if any(b - a < SPLIT_MIN_SECONDS * fps for a, b in zip(bounds, bounds[1:])) or bounds[-2] >= entry["end_frame"]:
            result.append(entry)  # части слишком короткие — не делим
            continue
        ids = list(entry.get("source_segment_ids", []))
        for k, piece in enumerate(pieces):
            asr_ids = {asr_words[i]["id"] for _, i in piece}
            part = dict(entry)
            part.update(
                start_frame=bounds[k], end_frame=bounds[k + 1],
                text=join([w for w, _ in piece]), source_text=join([w for w, _ in piece]),
                source_segment_ids=[i for i in ids if i in asr_ids] or ids,
                _words=piece,
            )
            result.append(part)
    return result


def proper_words(source_words: list[dict]) -> set[str]:
    """Слова, которые в источнике пишутся с большой буквы посреди предложения (имена и т.п.)."""
    names, prev = {"I"}, ""
    for w in source_words:
        word = re.sub(r"^[^\w]+|[^\w'’]+$", "", w["word"])
        if word[:1].isupper() and prev and not prev.endswith((".", "!", "?", "…", ":")) and not w.get("newline_before"):
            names.add(word.split("'")[0].split("’")[0])
        prev = w["word"]
    return names


def merge_comma_tails(entries: list[dict], fps: float, names: set[str]) -> list[dict]:
    """Склеивает фрагмент на запятой со следующим (см. описание модуля)."""
    result: list[dict] = []
    for entry in entries:
        prev = result[-1] if result else None
        text = (entry.get("text") or "").strip()
        if prev is not None and text and (prev.get("text") or "").rstrip().endswith(","):
            prev_lines = prev["text"].strip().split("\n")
            prev_speaker = _speaker(prev_lines[-1]) or next((_speaker(l) for l in reversed(prev_lines) if _speaker(l)), None)
            first_line = text.split("\n")[0]
            speaker = _speaker(first_line)
            long = (entry["end_frame"] - prev["start_frame"]) / fps > MERGE_MAX_SECONDS
            if not long and (speaker is None or speaker == prev_speaker):
                body = text
                if speaker is not None:
                    body = _SPEAKER_RE.sub("", text, count=1)
                word = re.match(r"[A-Za-z]+", body)
                if word and word.group(0) not in names and not word.group(0).isupper():
                    body = body[0].lower() + body[1:]
                prev["text"] = prev["text"].rstrip() + " " + body
                if prev.get("source_text") is not None:
                    prev["source_text"] = (prev.get("source_text") or "").rstrip() + " " + body
                prev["end_frame"] = entry["end_frame"]
                prev["source_segment_ids"] = list(prev.get("source_segment_ids", [])) + list(entry.get("source_segment_ids", []))
                prev["_words"] = list(prev.get("_words") or []) + list(entry.get("_words") or [])
                prev["needs_review"] = prev.get("needs_review", False) or entry.get("needs_review", False)
                prev["heard"] = prev.get("heard", False) or entry.get("heard", False)
                continue
        result.append(entry)
    return result
