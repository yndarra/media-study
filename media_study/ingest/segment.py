# -*- coding: utf-8 -*-
"""
Сегментация видео на фразовые и заполняющие (filler) фрагменты с гарантией
полного покрытия таймлайна — центральный алгоритм Фазы 1.

Фразы строятся из пословных таймкодов ASR: режем по заметным паузам и по
концу предложения (если фраза уже не совсем короткая). Короткие реплики
(одно-два слова) остаются отдельными фрагментами; приклеиваются к соседу
только явные сбои таймкодов Whisper — "фразы" короче GLITCH_SECONDS.
Паузы между фразами:
  - короткая пауза (< MIN_FILLER_SECONDS) делится пополам между соседями —
    отдельный фрагмент из пары кадров тишины бессмыслен;
  - длинная пауза (тишина, музыка) становится отдельным filler-фрагментом,
    а фразы по краям получают небольшой запас EDGE_PAD_SECONDS, чтобы не
    обрезать последние/первые звуки слов.
Итоговые интервалы стыкуются кадр-в-кадр от 0 до total_frames.
"""
import re

from media_study.core.context_bounds import CONTEXT_PADDING_SECONDS, context_for
from media_study.core.frames import frames_for_seconds
from media_study.core.text_clean import clean_text
from media_study.core.lang import join_texts, join_words
from media_study.core.manifest import Fragment, STATUS_ACTIVE

MAX_GAP_SECONDS = 0.7
MAX_PHRASE_SECONDS = 8.0
MAX_PHRASE_WORDS = 20
SENTENCE_SPLIT_MIN_SECONDS = 2.5
# Короче этого — не реплика, а сбой таймкодов (слово нулевой длины и т.п.).
GLITCH_SECONDS = 0.2
# Изолированный сбой (рядом нет соседа, к которому можно приклеить) —
# расширяется до этой длины, чтобы его можно было хотя бы услышать.
GLITCH_MIN_WIDTH_SECONDS = 0.5
MIN_FILLER_SECONDS = 1.0  # значение по умолчанию; проектное — в settings манифеста
EDGE_PAD_SECONDS = 0.25

_SENTENCE_END_RE = re.compile(r"[.?!…][\"')\]]*$")


def flatten_words(transcript: dict) -> list[dict]:
    """Единый пословный поток по всему видео, с устойчивыми id для трассировки."""
    words = []
    for segment in transcript["segments"]:
        words.extend(segment.get("words", []))
    words.sort(key=lambda w: w["start"])
    return [{"id": f"w{index:05d}", **word} for index, word in enumerate(words)]


def derive_raw_segments_from_words(words: list[dict]) -> list[dict]:
    """Режет пословный поток на черновые фразы (в секундах)."""
    if not words:
        return []
    segments = []
    current = [words[0]]
    for word in words[1:]:
        gap = word["start"] - current[-1]["end"]
        duration_so_far = current[-1]["end"] - current[0]["start"]
        would_be_duration = word["end"] - current[0]["start"]
        sentence_ended = bool(_SENTENCE_END_RE.search(current[-1]["word"]))
        if (
            gap > MAX_GAP_SECONDS
            or would_be_duration > MAX_PHRASE_SECONDS
            or len(current) >= MAX_PHRASE_WORDS
            or (sentence_ended and duration_so_far >= SENTENCE_SPLIT_MIN_SECONDS)
        ):
            segments.append(_segment_from_words(current))
            current = [word]
        else:
            current.append(word)
    segments.append(_segment_from_words(current))
    return segments


def _segment_from_words(words: list[dict]) -> dict:
    return {
        "start": words[0]["start"],
        "end": words[-1]["end"],
        "text": join_words(w["word"] for w in words),
        "source_segment_ids": [w["id"] for w in words],
    }


def merge_glitches(segments: list[dict], min_filler_seconds: float = MIN_FILLER_SECONDS) -> list[dict]:
    """
    Сбой таймкодов (< GLITCH_SECONDS) приклеивается к соседу с меньшей
    паузой — если пауза короче порога отдельной тишины. Если оба соседа
    далеко, сбой остаётся отдельным фрагментом, но расширяется до
    GLITCH_MIN_WIDTH_SECONDS, чтобы не было фрагмента в пару кадров.
    Настоящие короткие реплики (длиннее GLITCH_SECONDS) не трогаются.
    """
    result = [dict(s) for s in segments]
    changed = True
    while changed:
        changed = False
        for index, seg in enumerate(result):
            if seg["end"] - seg["start"] >= GLITCH_SECONDS:
                continue
            gap_prev = seg["start"] - result[index - 1]["end"] if index > 0 else None
            gap_next = result[index + 1]["start"] - seg["end"] if index + 1 < len(result) else None
            candidates = [
                (gap, neighbor)
                for gap, neighbor in ((gap_prev, index - 1), (gap_next, index + 1))
                if gap is not None and gap < min_filler_seconds
            ]
            if not candidates:
                center = (seg["start"] + seg["end"]) / 2
                half = GLITCH_MIN_WIDTH_SECONDS / 2
                low = result[index - 1]["end"] if index > 0 else 0.0
                high = result[index + 1]["start"] if index + 1 < len(result) else center + half
                seg["start"] = max(low, center - half)
                seg["end"] = min(high, center + half)
                continue
            _, neighbor = min(candidates)
            first, second = sorted((index, neighbor))
            a, b = result[first], result[second]
            result[first] = {
                "start": a["start"],
                "end": max(a["end"], b["end"]),
                "text": join_texts(a["text"], b["text"]),
                "source_segment_ids": [*a["source_segment_ids"], *b["source_segment_ids"]],
            }
            del result[second]
            changed = True
            break
    return result


def _merge_into(base: dict, extra: dict) -> None:
    """Сливает extra в base на месте: текст конкатенируется, конец расширяется."""
    base["end_frame"] = max(base["end_frame"], extra["end_frame"])
    base["text"] = join_texts(base["text"], extra["text"])
    base["source_segment_ids"] = [*base["source_segment_ids"], *extra["source_segment_ids"]]


def _resolve_overlaps(segments_frames: list[dict]) -> list[dict]:
    """
    Устраняет наложения одним проходом слева направо: старт каждого
    следующего интервала подтягивается к концу предыдущего. Если интервал
    при этом схлопывается (пословные таймкоды ASR у соседей перехлестнулись),
    он сливается с предыдущим — текст не теряется и нет фрагмента start==end.
    """
    resolved: list[dict] = []
    for segment in segments_frames:
        if resolved and segment["start_frame"] < resolved[-1]["end_frame"]:
            segment = dict(segment)
            segment["start_frame"] = resolved[-1]["end_frame"]
        if resolved and segment["start_frame"] >= segment["end_frame"]:
            _merge_into(resolved[-1], segment)
            continue
        resolved.append(segment)
    return resolved


def _filler(start_frame: int, end_frame: int) -> dict:
    return {"start_frame": start_frame, "end_frame": end_frame, "text": "", "source_segment_ids": []}


def fill_full_coverage(
    phrase_segments: list[dict],
    fps: float,
    total_frames: int,
    min_filler_seconds: float = MIN_FILLER_SECONDS,
    start_frame: int = 0,
) -> list[dict]:
    """
    Переводит фразы в кадры и закрывает все промежутки: короткие делятся
    между соседями, длинные становятся filler-фрагментами. Итог покрывает
    [start_frame, total_frames) без разрывов и наложений (start_frame > 0 —
    пересборка только хвоста видео, начало уже вынесено на этап 3).
    """
    min_filler = frames_for_seconds(min_filler_seconds, fps)
    pad = frames_for_seconds(EDGE_PAD_SECONDS, fps)

    phrases = sorted(
        (
            {
                "start_frame": frames_for_seconds(s["start"], fps),
                "end_frame": max(frames_for_seconds(s["end"], fps), frames_for_seconds(s["start"], fps) + 1),
                "text": s["text"],
                "source_segment_ids": list(s.get("source_segment_ids", [])),
            }
            for s in phrase_segments
        ),
        key=lambda s: s["start_frame"],
    )
    # Ничто не может начаться раньше start_frame.
    phrases = [dict(p, start_frame=max(p["start_frame"], start_frame)) for p in phrases if p["end_frame"] > start_frame]
    phrases = _resolve_overlaps(phrases)
    if not phrases:
        return [_filler(start_frame, total_frames)]

    entries: list[dict] = []

    # Отдельный filler создаётся, только если сама тишина — уже после запасов
    # EDGE_PAD по краям соседних фраз — не короче MIN_FILLER_SECONDS.
    first = phrases[0]
    if first["start_frame"] - start_frame >= min_filler + pad:
        first["start_frame"] -= pad
        entries.append(_filler(start_frame, first["start_frame"]))
    else:
        first["start_frame"] = start_frame

    for current, following in zip(phrases, phrases[1:]):
        entries.append(current)
        gap = following["start_frame"] - current["end_frame"]
        if gap >= min_filler + 2 * pad:
            current["end_frame"] += pad
            following["start_frame"] -= pad
            entries.append(_filler(current["end_frame"], following["start_frame"]))
        elif gap > 0:
            middle = (current["end_frame"] + following["start_frame"]) // 2
            current["end_frame"] = middle
            following["start_frame"] = middle

    last = phrases[-1]
    entries.append(last)
    if total_frames - last["end_frame"] >= min_filler + pad:
        last["end_frame"] += pad
        entries.append(_filler(last["end_frame"], total_frames))
    else:
        last["end_frame"] = total_frames
    return entries


def build_fragments(
    entries: list[dict],
    fps: float,
    total_frames: int,
    padding_seconds: float = CONTEXT_PADDING_SECONDS,
    first_id: int = 0,
) -> list[Fragment]:
    """Собирает финальные Fragment-объекты Фазы 1 с запасом ±padding_seconds."""
    fragments = []
    for index, entry in enumerate(entries, first_id):
        context_start, context_end = context_for(
            entry["start_frame"], entry["end_frame"], total_frames, fps, padding_seconds
        )
        fragments.append(Fragment(
            id=f"frag_{index:04d}",
            status=STATUS_ACTIVE,
            algo_start_frame=entry["start_frame"],
            algo_end_frame=entry["end_frame"],
            context_start_frame=context_start,
            context_end_frame=context_end,
            original_algo_start_frame=entry["start_frame"],
            original_algo_end_frame=entry["end_frame"],
            text=entry["text"],
            source_text=entry.get("source_text", ""),
            needs_review=entry.get("needs_review", False),
            review_note=entry.get("review_note", ""),
            source_segment_ids=entry.get("source_segment_ids", []),
            # Текст на слух (источник ничего не дал) — весь фрагмент голубой.
            heard_ranges=[[0, len(clean_text(entry["text"]))]] if entry.get("heard") else [],
        ))
    return fragments
