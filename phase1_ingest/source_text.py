# -*- coding: utf-8 -*-
"""
Пословное сопоставление текста внешнего источника (субтитры YouTube или
пользовательский транскрипт без таймкодов) с распознанными словами ASR.

Зачем пословно: раньше каждому фрагменту целиком приписывались все реплики
субтитров, пересекающиеся с ним по времени — одна реплика попадала сразу в
два соседних фрагмента, и текст повторялся. Здесь каждое слово источника
относится ровно к одному слову ASR, а значит ровно к одному фрагменту.

Источник может быть неполным, переполненным (пометки автора, вырезанные
реплики) или с опечатками — такие места просто хуже совпадают с ASR, и
фрагмент получает needs_review. "Умно" ничего не исправляется.
"""
from difflib import SequenceMatcher
from pathlib import Path
import re

from common.text_clean import clean_text

_TOKEN_RE = re.compile(r"[^a-z0-9']+")

# Если доля слов ASR фрагмента, совпавших с источником (в том числе
# нечётко), ниже порога — фрагмент помечается на проверку.
MIN_REVIEW_RATIO = 0.5


def _norm(word: str) -> str:
    return _TOKEN_RE.sub("", word.lower()).strip("'")


def words_from_cues(cues: list[dict]) -> list[dict]:
    """
    Превращает реплики субтитров в единый поток слов без повторов.

    YouTube часто отдаёт "накопительные" реплики: следующая повторяет конец
    предыдущей (прокрутка строк или дописывание слов). Поэтому к потоку
    добавляется только та часть реплики, которая не совпадает с уже
    накопленным хвостом. newline_before отмечает начало строки в исходной
    реплике — по нему потом ставится перенос строки вместо пробела.
    """
    stream: list[dict] = []
    for cue in sorted(cues, key=lambda c: c["start"]):
        cue_words = []
        # Сначала чистка: иначе невидимые пробелы из оформленных субтитров
        # становятся отдельными "словами" и портят и текст, и сопоставление.
        for line in clean_text(cue["text"]).split("\n"):
            for index, word in enumerate(line.split()):
                cue_words.append({"word": word, "newline_before": index == 0})
        overlap = 0
        for k in range(min(len(stream), len(cue_words)), 0, -1):
            tail = [_norm(w["word"]) for w in stream[-k:]]
            head = [_norm(w["word"]) for w in cue_words[:k]]
            if tail == head:
                overlap = k
                break
        stream.extend(cue_words[overlap:])
    return stream


def words_from_transcript(path: Path) -> list[dict]:
    """
    Текстовый транскрипт: каждая непустая строка — отдельная строка текста.
    Строка вида "Имя: реплика" — реплика персонажа: имя в сопоставление с
    речью не идёт (его не произносят), но запоминается у каждого слова
    реплики и потом ставится в начало строки фрагмента — кто что говорит.
    """
    from .sources.notion import dialogue_line

    stream = []
    for line in clean_text(Path(path).read_text(encoding="utf-8")).split("\n"):
        parsed = dialogue_line(line)
        speaker, text = parsed if parsed else (None, line)
        for index, word in enumerate(text.split()):
            stream.append({"word": word, "newline_before": index == 0, "speaker": speaker})
    return stream


def _join(words: list[dict]) -> str:
    """
    Текст фрагмента из слов источника. У реплик персонажей в начале каждой
    строки — имя говорящего ("Yangyang: ..."), в том числе когда фрагмент
    начинается с середины реплики.
    """
    parts = []
    for index, word in enumerate(words):
        new_line = word["newline_before"]
        if parts:
            parts.append("\n" if new_line else " ")
        if word.get("speaker") and (new_line or index == 0):
            parts.append(f"{word['speaker']}: ")
        parts.append(word["word"])
    return "".join(parts)


# Длинные куски источника, которым в речи ничего не соответствует, — лишний
# текст (побочные диалоги, которые в видео не выбрали, эпизоды за пределами
# видео, пометки): они отбрасываются, а не приклеиваются к соседней фразе.
EXTRA_TEXT_MIN_WORDS = 8

# Канон: главный герой (Rover) — парень. В источнике он местами героиня; если
# в речи на этом месте прозвучало мужское местоимение, берётся оно.
_FEMALE = {"she": "he", "her": "him", "hers": "his", "herself": "himself"}
_MALE = {"he", "him", "his", "himself"}


def _swap_pronoun(word: str, heard: str) -> str:
    """her, -> him, / Her -> Him: регистр первой буквы и знаки после слова сохраняются."""
    match = re.match(r"^([A-Za-z]+)(.*)$", word)
    if not match:
        return word
    new = heard.capitalize() if match.group(1)[:1].isupper() else heard
    return new + match.group(2)


# Нечёткое совпадение слов (rapidfuzz, 0..100): имена и термины игры ASR
# слышит по-своему ("Zhengzhou" вместо "Jinzhou", "long" вместо "Loong").
FUZZY_MIN_SIMILARITY = 55
# Реплика источника, у которой в речи нашлось меньше этой доли слов, —
# лишний текст (побочный диалог, который в видео не выбрали, и т.п.).
EXTRA_LINE_MAX_MATCHED = 0.2
# Больше этого числа клеток нечёткое сопоставление участка не считается
# (по памяти); такой участок сопоставляется только по точным совпадениям.
FUZZY_MAX_CELLS = 12_000_000


def _match_tokens(source_words: list[dict]) -> list[str | None]:
    """
    Токены источника для сопоставления с речью. Пояснения в скобках
    ("(Oracle Engine)", "(dragon)") вслух не произносятся — в сопоставлении
    не участвуют (None), но в тексте остаются.
    """
    tokens = []
    in_paren = False
    for word in source_words:
        text = word["word"]
        starts = text.startswith("(") or text.startswith("（")
        if starts:
            in_paren = True
        tokens.append(None if in_paren else (_norm(text) or None))
        if in_paren and (")" in text or "）" in text):
            in_paren = False
    return tokens


def _fuzzy_pairs(a: list[str], b: list[str]) -> list[tuple[int, int]]:
    """
    Пары (i, j) похожих слов двух участков по порядку, максимизирующие сумму
    похожести (выравнивание как в diff, но слова сравниваются нечётко).
    """
    import numpy as np
    from rapidfuzz import fuzz, process

    if not a or not b or len(a) * len(b) > FUZZY_MAX_CELLS:
        return []
    sim = process.cdist(a, b, scorer=fuzz.ratio, dtype=np.float32)
    weight = np.where(sim >= FUZZY_MIN_SIMILARITY, sim, -np.inf)
    rows, cols = len(a), len(b)
    score = np.zeros((rows + 1, cols + 1), dtype=np.float32)
    for i in range(1, rows + 1):
        prev = score[i - 1]
        candidate = np.maximum(prev[1:], prev[:-1] + weight[i - 1])
        row = np.empty(cols + 1, dtype=np.float32)
        row[0] = 0.0
        row[1:] = candidate
        score[i] = np.maximum.accumulate(row)
    pairs = []
    i, j = rows, cols
    while i > 0 and j > 0:
        if score[i, j] == score[i, j - 1]:
            j -= 1
        elif score[i, j] == score[i - 1, j]:
            i -= 1
        else:
            pairs.append((i - 1, j - 1))
            i -= 1
            j -= 1
    pairs.reverse()
    return pairs


def _lines(source_words: list[dict]) -> list[list[int]]:
    """Индексы слов источника по репликам (строкам)."""
    lines: list[list[int]] = []
    for index, word in enumerate(source_words):
        if word.get("newline_before") or not lines:
            lines.append([])
        lines[-1].append(index)
    return lines


def map_source_to_asr(
    asr_words: list[dict], source_words: list[dict], unvoiced: set[str] | None = None,
) -> tuple[list[int | None], list[bool]]:
    """
    Сопоставление источника с речью: для каждого слова источника — индекс
    слова ASR, к которому оно относится (None — лишний текст, в речи его нет),
    и для каждого слова ASR — нашлось ли ему соответствие.

    1. Точные совпадения (difflib) — опоры; участки между ними выравниваются
       нечётко (похожие по написанию слова).
    2. Реплика, почти ничего не нашедшая в речи, — лишняя (None целиком).
       Исключение — "неозвученные" персонажи (unvoiced, например Rover: его
       реплики — выбор ответа, их не произносят): их реплика остаётся, если
       озвученные реплики вокруг неё есть в видео, и приклеивается к концу
       предыдущей фразы.
    3. Остальные слова реплики (скобки, неуслышанные) — к соседнему
       сопоставленному слову той же реплики.
    """
    unvoiced = unvoiced or set()
    asr_tokens = [_norm(w["word"]) for w in asr_words]
    tokens = _match_tokens(source_words)
    matchable = [i for i, t in enumerate(tokens) if t]
    seq = [tokens[i] for i in matchable]

    src_to_asr: list[int | None] = [None] * len(source_words)
    asr_matched = [False] * len(asr_words)
    for tag, a1, a2, b1, b2 in SequenceMatcher(None, asr_tokens, seq, autojunk=False).get_opcodes():
        if tag == "equal":
            for offset in range(b2 - b1):
                src_to_asr[matchable[b1 + offset]] = a1 + offset
                asr_matched[a1 + offset] = True
        elif tag == "replace":
            for i, j in _fuzzy_pairs(asr_tokens[a1:a2], seq[b1:b2]):
                src_to_asr[matchable[b1 + j]] = a1 + i
                asr_matched[a1 + i] = True

    lines = _lines(source_words)
    voiced_kept: list[bool | None] = []  # по репликам: None — неозвученная
    for line in lines:
        speaker = source_words[line[0]].get("speaker")
        if speaker in unvoiced:
            voiced_kept.append(None)
            continue
        counted = [i for i in line if tokens[i]]
        mapped = [i for i in counted if src_to_asr[i] is not None]
        extra = not mapped or (len(counted) >= 3 and len(mapped) / len(counted) < EXTRA_LINE_MAX_MATCHED)
        if extra:
            for i in line:
                src_to_asr[i] = None
        voiced_kept.append(not extra)

    last_mapped: int | None = None
    for n, line in enumerate(lines):
        if voiced_kept[n] is None:
            # Неозвученная реплика: остаётся, если ближайшие озвученные реплики
            # до и после неё есть в видео; приклеивается к предыдущей фразе.
            before = next((voiced_kept[k] for k in range(n - 1, -1, -1) if voiced_kept[k] is not None), False)
            after = next((voiced_kept[k] for k in range(n + 1, len(lines)) if voiced_kept[k] is not None), False)
            target = last_mapped if last_mapped is not None else next(
                (src_to_asr[i] for k in range(n + 1, len(lines)) for i in lines[k] if src_to_asr[i] is not None), None)
            for i in line:
                src_to_asr[i] = target if (before and after and target is not None) else None
            continue
        if not voiced_kept[n]:
            continue
        mapped_positions = [i for i in line if src_to_asr[i] is not None]
        for i in line:
            if src_to_asr[i] is None:
                earlier = [k for k in mapped_positions if k < i]
                later = [k for k in mapped_positions if k > i]
                src_to_asr[i] = src_to_asr[earlier[-1]] if earlier else src_to_asr[later[0]]
        last_mapped = src_to_asr[line[-1]]
    return src_to_asr, asr_matched


def trim_extra_source(asr_words: list[dict], source_words: list[dict], unvoiced: set[str] | None = None) -> list[dict]:
    """Источник без реплик, которых нет в речи (см. map_source_to_asr)."""
    src_to_asr, _ = map_source_to_asr(asr_words, source_words, unvoiced)
    kept = []
    dropped = False
    for word, target in zip(source_words, src_to_asr):
        if target is None:
            dropped = True
            continue
        if dropped:
            # После выброшенного куска оставшаяся реплика — с новой строки.
            word = {**word, "newline_before": True}
            dropped = False
        kept.append(word)
    return kept


def assign_source_words(entries: list[dict], asr_words: list[dict], source_words: list[dict],
                        unvoiced: set[str] | None = None) -> None:
    """
    Проставляет каждому фразовому интервалу (entries, по source_segment_ids —
    id слов ASR) его часть текста источника. Меняет entries на месте:
    source_text, text (канонический: источник, если ему можно доверять),
    needs_review, review_note.
    """
    asr_index_by_id = {word["id"]: index for index, word in enumerate(asr_words)}
    entry_of_asr = [None] * len(asr_words)
    for entry_index, entry in enumerate(entries):
        for word_id in entry.get("source_segment_ids", []):
            if word_id in asr_index_by_id:
                entry_of_asr[asr_index_by_id[word_id]] = entry_index

    src_to_asr, asr_matched = map_source_to_asr(asr_words, source_words, unvoiced)
    source_words = [dict(w) for w in source_words]
    for src_index, asr_index in enumerate(src_to_asr):
        if asr_index is None:
            continue
        female = _norm(source_words[src_index]["word"])
        heard = _norm(asr_words[asr_index]["word"]) if asr_words else ""
        # she/he похожи — нечёткое сопоставление их связывает; меняем, если
        # на этом месте реально прозвучало мужское местоимение.
        if female in _FEMALE and heard in _MALE:
            source_words[src_index]["word"] = _swap_pronoun(source_words[src_index]["word"], heard)

    words_per_entry: dict[int, list[dict]] = {}
    for src_index, asr_index in enumerate(src_to_asr):
        if not asr_words or asr_index is None:
            continue
        entry_index = entry_of_asr[asr_index]
        if entry_index is not None:
            words_per_entry.setdefault(entry_index, []).append(source_words[src_index])

    for entry_index, entry in enumerate(entries):
        asr_ids = [asr_index_by_id[i] for i in entry.get("source_segment_ids", []) if i in asr_index_by_id]
        entry["source_text"] = _join(words_per_entry.get(entry_index, []))
        if not asr_ids:
            continue
        ratio = sum(asr_matched[i] for i in asr_ids) / len(asr_ids)
        # Текст — всегда из источника, если фрагменту что-то из него досталось:
        # имена и термины на слух не пишутся. Низкое совпадение — только пометка.
        if entry["source_text"]:
            entry["text"] = entry["source_text"]
        else:
            entry["needs_review"] = True
            entry["review_note"] = "в источнике не найдено — текст на слух"
            entry["heard"] = bool(entry.get("text", "").strip())  # в редакторе — голубым
            continue
        if ratio < MIN_REVIEW_RATIO:
            entry["needs_review"] = True
            entry["review_note"] = f"совпадение с источником {ratio:.0%}"
        # В источнике намного больше слов, чем прозвучало: выкрики, звуки,
        # лишние реплики, которым не к чему привязаться по времени, — весь
        # этот текст попадает сюда и его стоит просмотреть глазами.
        source_count = len(words_per_entry.get(entry_index, []))
        if source_count > 2 * len(asr_ids) + 6:
            entry["needs_review"] = True
            note = f"в источнике {source_count} слов, распознано {len(asr_ids)} — лишний текст?"
            entry["review_note"] = f"{entry['review_note']}; {note}" if entry.get("review_note") else note
