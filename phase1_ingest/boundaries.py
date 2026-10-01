# -*- coding: utf-8 -*-
"""
Где резать речь на фразы — выбор границ по смыслу, а не "до первого лимита".

Раньше поток слов резался жадно: на паузе, на конце предложения или просто
когда набиралось 20 слов / 8 секунд. Whisper же часто выдаёт быструю речь
сплошным потоком — без пауз между словами и без точек, — и тогда срабатывал
только лимит длины, разрезая фразу посреди смысла ("...only 10% of the way |
to our helicopter.").

Теперь у каждой возможной границы между соседними словами есть оценка —
насколько здесь уместен разрез, — из нескольких независимых признаков:
  - модель SaT ("Segment any Text", wtpsplit) по самому тексту распознавания
    предсказывает границы предложений и смысловых кусков; ей не нужны ни
    пунктуация, ни заглавные буквы, и она терпима к опечаткам — поэтому
    годится и для видео без субтитров, и для будущих игровых транскриптов;
  - пунктуация и переносы строк источника (субтитры/транскрипт), перенесённые
    на слова ASR через пословное сопоставление: точка — сильный довод, запятая
    и перенос строки — послабее;
  - пауза между словами;
  - штраф за разрез после служебного слова ("the", "of", "to" ...) — так
    фраза почти никогда не должна заканчиваться.
Затем разрезы выбираются оптимально сразу для всего видео (динамическое
программирование): суммарная цена = цена разрезов в неудачных местах +
цена "проглоченных" удачных границ внутри фраз + цена длины каждой фразы.
Цена длины настроена по ручной разметке пользователя (обычно 2–4 строки
субтитров, ~1–7.5 с, медиана ~3.7 с): короткие реплики можно склеивать,
слишком длинные фразы дороги, а разнообразие длины не наказывается.

Модель необязательна: без wtpsplit работают остальные признаки.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path

from .source_text import map_source_to_asr

SAT_MODEL = "sat-12l-sm"

# Паузы: длиннее — граница обязательна (здесь всё равно будет тишина-filler).
HARD_GAP_SECONDS = 1.0

# Веса признаков и цены. Подобраны по ручной разметке пользователя
# (фрагменты 1–90 первого видео): при них разрезы посреди предложения
# случаются в ~1% случаев (жадная нарезка — 14%), после служебных слов —
# вчетверо реже, а медиана длины фразы та же (~3.2 с).
WEIGHTS = {
    "cut": 1.0,  # цена разреза в неудачном месте: cut * -log(p)
    "miss": 1.0,  # цена удачной границы, оставшейся внутри фразы: miss * -log(1 - p)
    "length": 4.0,  # вес цены длины
    "function_word": 3.0,  # доп. цена разреза после служебного слова
    "segment": 1.5,  # постоянная цена каждой новой фразы — против дробления на обрывки
}

# Уверенность признаков в том, что здесь граница.
SOURCE_SENTENCE_END = 0.9
SOURCE_CLAUSE_END = 0.45
SOURCE_LINE_BREAK = 0.15  # переносы строк субтитров часто идут посреди фразы
ASR_SENTENCE_END = 0.6
ASR_CLAUSE_END = 0.3

_SENTENCE_END_RE = re.compile(r"[.?!…][\"')\]]*$")
_CLAUSE_END_RE = re.compile(r"(?:[,;:]|--|—)[\"')\]]*$")

# После этих слов фраза почти никогда не заканчивается.
FUNCTION_WORDS = {
    "a", "an", "the", "of", "to", "and", "or", "but", "so", "with", "for", "in", "on", "at", "by",
    "from", "into", "my", "your", "our", "their", "his", "her", "its", "this", "that", "these",
    "those", "is", "are", "was", "were", "be", "been", "am", "i", "we", "you", "they", "he", "she",
    "it's", "i'm", "we're", "you're", "they're", "gonna", "gotta", "wanna", "if", "because", "than",
    "as", "about", "like", "just", "very", "really", "not", "no", "some", "any", "every", "each",
}

EPS = 1e-4


def _norm(word: str) -> str:
    return re.sub(r"[^a-z0-9']+", "", word.lower()).strip("'")


# -- признаки --------------------------------------------------------------------


def source_boundary_probs(asr_words: list[dict], source_words: list[dict]) -> list[float]:
    """
    Для каждого слова ASR i — уверенность, что после него граница, по
    пунктуации и переносам строк источника (и по собственной пунктуации ASR).
    """
    n = len(asr_words)
    probs = [0.0] * n
    for i, word in enumerate(asr_words):
        text = word["word"].strip()
        if _SENTENCE_END_RE.search(text):
            probs[i] = max(probs[i], ASR_SENTENCE_END)
        elif _CLAUSE_END_RE.search(text):
            probs[i] = max(probs[i], ASR_CLAUSE_END)
    if not source_words or not asr_words:
        return probs
    src_to_asr, _ = map_source_to_asr(asr_words, source_words)
    for s, word in enumerate(source_words):
        i = src_to_asr[s]
        if i is None:
            continue  # лишний текст — в речи его нет
        # Признак относится к границе после последнего слова источника,
        # сопоставленного этому слову ASR.
        if s + 1 < len(source_words) and src_to_asr[s + 1] == i:
            continue
        # "11%," в источнике — одно слово, а у ASR "11" и "%" отдельно:
        # знак препинания относится к концу всей группы, то есть к "%".
        while i + 1 < n and not _norm(asr_words[i + 1]["word"]) and (
            s + 1 >= len(source_words) or src_to_asr[s + 1] != i + 1
        ):
            i += 1
        text = word["word"].strip()
        if _SENTENCE_END_RE.search(text):
            probs[i] = max(probs[i], SOURCE_SENTENCE_END)
        elif _CLAUSE_END_RE.search(text):
            probs[i] = max(probs[i], SOURCE_CLAUSE_END)
        if s + 1 < len(source_words) and source_words[s + 1].get("newline_before"):
            probs[i] = max(probs[i], SOURCE_LINE_BREAK)
    return probs


_sat_model = None


def _load_sat():
    global _sat_model
    if _sat_model is None:
        from wtpsplit import SaT

        _sat_model = SaT(SAT_MODEL, ort_providers=["CPUExecutionProvider"])
    return _sat_model


def model_boundary_probs(asr_words: list[dict], cache_path: Path | None = None) -> list[float] | None:
    """
    Вероятность границы после каждого слова ASR по модели SaT. Результат
    кэшируется рядом с проектом (модель грузится ~25 с, пересчёт не нужен,
    пока не изменился сам текст распознавания). None — если wtpsplit нет.
    """
    # Модели отдаём текст без заглавных букв и знаков: заглавные у Whisper
    # случайны ("...struggling We were...") и сбивают её, а без них она
    # опирается на смысл — так она и обучена работать с сырым текстом.
    words = [re.sub(r"[^\w'%]+", "", w["word"].lower()) or w["word"].strip() for w in asr_words]
    key = hashlib.sha1(("\u0001".join(words) + SAT_MODEL + "lower-v2").encode("utf-8")).hexdigest()
    if cache_path and Path(cache_path).exists():
        cached = json.loads(Path(cache_path).read_text(encoding="utf-8"))
        if cached.get("key") == key:
            return cached["probs"]
    try:
        sat = _load_sat()
    except ImportError:
        return None
    text = " ".join(words)
    char_probs = sat.predict_proba(text)
    probs = []
    position = 0
    for word in words:
        end = position + len(word)
        # Граница "после слова" — самый вероятный разрез на его последнем
        # символе или на пробеле за ним.
        window = char_probs[max(position, end - 1): min(len(char_probs), end + 1)]
        probs.append(float(max(window)) if len(window) else 0.0)
        position = end + 1
    if cache_path:
        Path(cache_path).write_text(json.dumps({"key": key, "probs": probs}), encoding="utf-8")
    return probs


def combine(*prob_lists: list[float] | None) -> list[float]:
    """Независимые доводы "здесь граница" объединяются как шансы: 1 - Π(1 - p)."""
    lists = [p for p in prob_lists if p is not None]
    n = len(lists[0])
    result = []
    for i in range(n):
        keep = 1.0
        for probs in lists:
            keep *= 1.0 - min(max(probs[i], 0.0), 1.0 - EPS)
        result.append(1.0 - keep)
    return result


# -- выбор разрезов --------------------------------------------------------------


def length_cost(duration: float, words: int) -> float:
    """
    Цена длины фразы. Удобный диапазон почти бесплатен (разнообразие
    приветствуется), за его краями цена быстро растёт: < 0.8 с — обрывок,
    > 7.5 с или > 24 слов — уже тяжело для карточки.
    """
    cost = math.log(max(duration, 0.2) / 3.7) ** 2
    if duration < 0.8:
        cost += 4.0 * (0.8 - duration) / 0.8
    if duration > 7.5:
        cost += 1.5 * (duration - 7.5) ** 2
    if words > 24:
        cost += 0.8 * (words - 24) ** 2
    return cost


def choose_segments(
    asr_words: list[dict],
    boundary_probs: list[float],
    weights: dict | None = None,
    max_words: int = 45,
    hard_gap_seconds: float = HARD_GAP_SECONDS,
) -> list[list[int]]:
    """
    Оптимальное разбиение потока слов на фразы. Возвращает списки индексов
    слов. После слова i разрез обязателен, если дальше пауза >= hard_gap_seconds
    (там всё равно будет отдельная тишина-filler).
    """
    w = {**WEIGHTS, **(weights or {})}
    n = len(asr_words)
    if n == 0:
        return []
    hard = [
        i == n - 1 or asr_words[i + 1]["start"] - asr_words[i]["end"] >= hard_gap_seconds
        for i in range(n)
    ]
    cut_cost = []
    miss_cost = []
    for i in range(n):
        p = min(max(boundary_probs[i], EPS), 1.0 - EPS)
        extra = w["function_word"] if _norm(asr_words[i]["word"]) in FUNCTION_WORDS else 0.0
        cut_cost.append(0.0 if hard[i] else w["cut"] * -math.log(p) + extra)
        miss_cost.append(w["miss"] * -math.log(1.0 - p))

    INF = float("inf")
    best = [INF] * (n + 1)  # best[k] — цена лучшего разбиения первых k слов
    back = [0] * (n + 1)
    best[0] = 0.0
    for end in range(1, n + 1):  # фраза — слова [start, end)
        inside = 0.0
        for start in range(end - 1, max(-1, end - 1 - max_words), -1):
            if start < end - 1:
                # Граница после слова start теперь внутри фразы.
                if hard[start]:
                    break
                inside += miss_cost[start]
            if best[start] == INF:
                continue
            duration = asr_words[end - 1]["end"] - asr_words[start]["start"]
            total = (
                best[start] + inside + cut_cost[end - 1] + w["segment"]
                + w["length"] * length_cost(duration, end - start)
            )
            if total < best[end]:
                best[end] = total
                back[end] = start
    segments = []
    end = n
    while end > 0:
        start = back[end]
        segments.append(list(range(start, end)))
        end = start
    segments.reverse()
    return segments


def segment_words(
    asr_words: list[dict],
    source_words: list[dict] | None = None,
    cache_path: Path | None = None,
    use_model: bool = True,
    weights: dict | None = None,
    hard_gap_seconds: float = HARD_GAP_SECONDS,
    start_seconds: float = 0.0,
) -> list[dict]:
    """
    Черновые фразы (в секундах) — в том же виде, что раньше давала жадная
    нарезка. start_seconds — резать только речь после этого момента (слово
    относится к нему, если его середина позже): признаки всё равно считаются
    по всему видео, чтобы модель и сопоставление с источником видели контекст.
    """
    if not asr_words:
        return []
    probs = combine(
        source_boundary_probs(asr_words, source_words or []),
        model_boundary_probs(asr_words, cache_path) if use_model else None,
    )
    keep = [i for i, w in enumerate(asr_words) if (w["start"] + w["end"]) / 2 >= start_seconds]
    words = [asr_words[i] for i in keep]
    probs = [probs[i] for i in keep]
    result = []
    for indices in choose_segments(words, probs, weights, hard_gap_seconds=hard_gap_seconds):
        chunk = [words[i] for i in indices]
        result.append({
            "start": chunk[0]["start"],
            "end": chunk[-1]["end"],
            "text": " ".join(x["word"] for x in chunk),
            "source_segment_ids": [x["id"] for x in chunk],
        })
    return result
