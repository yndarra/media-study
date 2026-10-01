# -*- coding: utf-8 -*-
"""
Вспомогательный алгоритм этапа 2: строки фрагментов, записанные НА СЛУХ
(без "Имя: " — текст распознавания), заменить репликами из источника
(transcript.txt — реплики из Notion, "Имя: текст").

Зачем: при первой сборке строгое сопоставление с речью не узнавало имена и
термины ("Zhengzhou" вместо "Jinzhou", "Baija" вместо "Baizhi"), и у таких
фрагментов оставался текст распознавания без говорящего.

Как ищется замена (локально, границы и уже выверенный текст не трогаются):
  1. Строки "Имя: текст" во фрагментах уже из источника — находим, какой
     реплике источника каждая соответствует (идём по порядку, нечётко).
     Это опоры.
  2. Для строки на слух окно поиска — реплики источника между опорой
     предыдущих фрагментов и опорой следующих (включительно: фраза могла
     начаться или закончиться посреди реплики).
  3. В окне ищется самый похожий кусок: реплика целиком, две-три подряд или
     кусок реплики по границам слов (rapidfuzz). Похожесть ниже порога —
     строка остаётся как есть (и фрагмент — на проверку).

Правки идут через сервер редактора (как ручные): попадают в историю
фрагмента и отменяются кнопкой "назад". Фрагменты, переданные в Anki
(exported) или удалённые, не трогаются.

  py -3.12 -m phase2_tools.retext_from_source --project yiAxdzOQKG4 --from 85 [--apply] [--report файл]
  py -3.12 -m phase2_tools.retext_from_source --project yiAxdzOQKG4 --from 125 --mark-heard [--apply]
--mark-heard — только отметить голубым строки на слух у готовых фрагментов
(строка на слух = её текста нет ни в одной реплике источника).
Без --apply — только отчёт.
"""
import argparse
import re
import sys
import urllib.error
from pathlib import Path

from rapidfuzz import fuzz

from common.text_clean import clean_text
from phase1_ingest.sources.notion import dialogue_line
from phase2_tools.separate_speaker import api

ROOT = Path(__file__).resolve().parent.parent
_SPEAKER_LINE = re.compile(r"^([A-Z][\w .'’-]{0,50}): (.*)$")
# Порог похожести куска источника на строку на слух (0..100): кусок ставится,
# если похожесть >= STRONG_SCORE, или >= MIN_SCORE и строка не совсем короткая
# (одно-два слова случайно похожи на что угодно: "Rover." ~ "proper").
MIN_SCORE = 65
STRONG_SCORE = 75
SHORT_SCORE = 90
# Сколько реплик источника искать до первой / после последней опоры.
EDGE_LINES = 20
# Порог, с которым строка "Имя: текст" считается найденной в источнике (опора).
ANCHOR_SCORE = 85
# На сколько реплик вперёд (и назад) от предыдущей опоры искать следующую.
ANCHOR_LOOKAHEAD = 80
ANCHOR_LOOKBACK = 15
# Запас окна поиска (реплик) по обе стороны от опор.
WINDOW_MARGIN = 8


def _norm(text: str) -> str:
    """Для сравнения: только буквы/цифры, пробелы между словами; скобки-пояснения выкинуты."""
    text = re.sub(r"\([^)]*\)", " ", text.lower())
    return " ".join(re.sub(r"[^a-z0-9']+", " ", text).split())


def load_source_lines(path: Path) -> list[tuple[str | None, str]]:
    """Реплики источника: (говорящий или None, текст)."""
    lines = []
    for line in clean_text(Path(path).read_text(encoding="utf-8")).split("\n"):
        if not line.strip():
            continue
        parsed = dialogue_line(line)
        lines.append(parsed if parsed else (None, line.strip()))
    return lines


def locate_anchors(fragments: list[dict], start: int, source: list[tuple[str | None, str]]) -> dict[int, list[int]]:
    """
    Для фрагментов (индексы >= start - 20, чтобы было от чего оттолкнуться) —
    индексы реплик источника, которым соответствуют их строки "Имя: текст".
    Поиск идёт по порядку: следующая опора ищется после предыдущей.
    """
    normed = [_norm(text) for _, text in source]
    anchors: dict[int, list[int]] = {}
    pointer = 0
    first = True
    for index in range(max(0, start - 20), len(fragments)):
        fragment = fragments[index]
        if fragment["status"] != "active":
            continue
        for line in fragment["text"].split("\n"):
            match = _SPEAKER_LINE.match(line.strip())
            if not match:
                continue
            speaker, text = match.group(1), _norm(match.group(2))
            if len(text) < 3:
                continue  # "...", "Hmm" — слишком коротко для опоры
            # Первая опора ищется по всему источнику, дальше — рядом с предыдущей.
            low = 0 if first else max(0, pointer - ANCHOR_LOOKBACK)
            high = len(source) if first else min(len(source), pointer + ANCHOR_LOOKAHEAD)
            best, best_score = None, 0.0
            for k in range(low, high):
                if source[k][0] != speaker or not normed[k]:
                    continue
                score = fuzz.partial_ratio(text, normed[k]) if len(text) <= len(normed[k]) else fuzz.ratio(text, normed[k])
                # При равенстве — ближайшая к указателю.
                if score > best_score or (score == best_score and best is not None and abs(k - pointer) < abs(best - pointer)):
                    best, best_score = k, score
            if best is not None and best_score >= ANCHOR_SCORE:
                anchors.setdefault(index, []).append(best)
                pointer = best
                first = False
    return anchors


def previous_line(fragments: list[dict], index: int) -> str | None:
    """Последняя строка ближайшего непустого активного фрагмента слева (не дальше 2)."""
    for k in (index - 1, index - 2):
        if k >= 0 and fragments[k]["status"] == "active" and fragments[k]["text"].strip():
            return fragments[k]["text"].strip().split("\n")[-1]
    return None


def nearest_speaker(fragments: list[dict], index: int, exclude: set[str] = frozenset()) -> str | None:
    """
    Говорящий ближайшей строки "Имя: текст" в соседних фрагментах (сначала
    слева), кроме exclude (к ним обращаются в строке — значит, говорят не они).
    """
    for distance in range(1, 16):
        for k in (index - distance, index + distance):
            if 0 <= k < len(fragments) and fragments[k]["status"] == "active":
                lines = [l for l in fragments[k]["text"].split("\n") if _SPEAKER_LINE.match(l.strip())
                         and _SPEAKER_LINE.match(l.strip()).group(1).lower() not in exclude]
                if lines:
                    line = lines[-1] if k < index else lines[0]
                    return _SPEAKER_LINE.match(line.strip()).group(1)
    return None


def _word_spans(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in re.finditer(r"\S+", text)]


def best_piece(heard: str, source: list[tuple[str | None, str]], low: int, high: int):
    """
    Самый похожий на строку на слух кусок источника в репликах [low, high]:
    (оценка, текст "Имя: ...", индекс первой реплики) или None.
    Кандидаты: 1–3 реплики подряд (одного говорящего — одна строка "Имя:"),
    и кусок одной реплики по границам слов.
    """
    target = _norm(heard)
    if not target:
        return None
    best = None
    for k in range(low, high + 1):
        speaker, text = source[k]
        # Кусок реплики: окно слов, по длине близкое к услышанному.
        words = _word_spans(text)
        heard_len = len(target.split())
        for size in range(max(1, heard_len - 3), min(len(words), heard_len + 4) + 1):
            for first in range(0, len(words) - size + 1):
                piece = text[words[first][0]: words[first + size - 1][1]]
                score = fuzz.ratio(target, _norm(piece))
                if best is None or score > best[0]:
                    best = (score, f"{speaker}: {piece}" if speaker else piece, k)
        # Несколько реплик подряд целиком.
        for count in (2, 3):
            if k + count - 1 > high:
                break
            group = source[k: k + count]
            joined = " ".join(t for _, t in group)
            score = fuzz.ratio(target, _norm(joined))
            if best is None or score > best[0]:
                rendered = "\n".join(f"{s}: {t}" if s else t for s, t in group)
                best = (score, rendered, k)
    return best


def proper_nouns(source: list[tuple[str | None, str]]) -> dict[str, str]:
    """
    Имена и термины источника: слова, которые в нём ВСЕГДА пишутся с заглавной
    (Baizhi, Jinzhou, Tacet, Resonator). {нижний регистр: написание}.
    Слова, встречающиеся и строчными ("long", "field"), — обычные, не термины
    (допускается редкая опечатка источника: строчными не больше 10% случаев).
    """
    spelled: dict[str, str] = {}
    upper: dict[str, int] = {}
    lower: dict[str, int] = {}
    # Имена говорящих — термины заведомо.
    for speaker, _ in source:
        if speaker and len(speaker) >= 3:
            spelled.setdefault(speaker.lower(), speaker)
            upper[speaker.lower()] = upper.get(speaker.lower(), 0) + 1
    for text in (t for _, t in source):
        for match in re.finditer(r"[A-Za-z][A-Za-z'’-]*", text):
            word = re.sub(r"['’]s$", "", match.group(0).strip("'’-"))
            if len(word) < 3:
                continue
            key = word.lower()
            # С заглавной в начале предложения пишется что угодно — не в счёт.
            before = text[: match.start()].rstrip(" \"'“”‘’(")
            if word[0].isupper() and (not before or before[-1] in ".!?…:"):
                continue
            if word[0].isupper():
                spelled.setdefault(key, word)
                upper[key] = upper.get(key, 0) + 1
            else:
                lower[key] = lower.get(key, 0) + 1
    return {k: v for k, v in spelled.items() if lower.get(k, 0) <= 0.1 * upper[k]}


def known_words(source: list[tuple[str | None, str]]) -> set[str]:
    return {w.lower().strip("'’-") for _, t in source for w in re.findall(r"[A-Za-z][A-Za-z'’-]*", t)}


# Первые буквы, которые на слух путаются (китайские имена в английской
# озвучке и распознавании): Jinzhou ~ Chinchou/Jenjou, Qiuyuan ~ Chiuyuan.
_INITIAL_GROUPS = ["cjzqx", "gk", "bp", "dt", "fv", "sz", "wv"]


def _similar_initials(a: str, b: str) -> bool:
    if a[:2] in ("ch", "zh", "sh") or b[:2] in ("ch", "zh", "sh"):
        return a[0] in "cjzsq" and b[0] in "cjzsq"
    return any(a[0] in group and b[0] in group for group in _INITIAL_GROUPS)


def fix_terms(heard: str, terms: dict[str, str], known: set[str]) -> str:
    """
    Слова на слух, похожие на имя/термин источника, — его написанием
    ("Baija" -> "Baizhi", "tacit" -> "Tacet", "Yang Yang" -> "Yangyang").
    Слово, которое в источнике встречается само по себе, не трогается.
    """
    tokens = re.findall(r"\S+", heard)
    out: list[str] = []
    i = 0
    while i < len(tokens):
        # Сначала пара слов слитно ("Yang Yang" -> "Yangyang", "Huang Long's" -> "Huanglong's").
        if i + 1 < len(tokens):
            first = re.match(r"^([^A-Za-z]*)([A-Za-z]+)$", tokens[i])
            second = re.match(r"^([A-Za-z]+)(.*)$", tokens[i + 1])
            if first and second and (first.group(2) + second.group(1)).lower() in terms:
                out.append(first.group(1) + terms[(first.group(2) + second.group(1)).lower()] + second.group(2))
                i += 2
                continue
        out.append(tokens[i])
        i += 1

    def parts(token: str):
        match = re.match(r"^([^A-Za-z]*)([A-Za-z]+)(.*)$", token)
        return match.groups() if match else None

    def is_term(token: str) -> bool:
        p = parts(token)
        return bool(p) and p[1].lower() in terms

    result = []
    for n, token in enumerate(out):
        p = parts(token)
        if not p:
            result.append(token)
            continue
        head, core, tail = p
        low = core.lower()
        if low in terms:
            # Термин целиком ("jinzhou" -> "Jinzhou"); "Discord" в "tacit discord" и т.п.
            result.append(head + terms[low] + tail)
            continue
        if low in known or len(low) < 5:
            result.append(token)  # обычное слово источника или междометие ("Hiya", "Hmm")
            continue
        # Строчное слово — почти всегда обычное английское ("resonated"):
        # заменяется, только если рядом термин ("tacit discord" -> "Tacet Discord").
        near_term = (n > 0 and is_term(out[n - 1])) or (n + 1 < len(out) and is_term(out[n + 1]))
        if not core[0].isupper() and not near_term:
            result.append(token)
            continue
        # Порог: строчное — 75; с заглавной — 61, а при той же первой букве и
        # почти той же длине — 50 ("Baija" -> "Baizhi", но не "Legion" -> "Loon").
        best, best_score = None, 0.0
        for key, spelled in terms.items():
            if abs(len(key) - len(low)) > 3:
                continue
            score = fuzz.ratio(low, key)
            # Первая буква другая — только если звуки похожи (Chinchou ~
            # Jinzhou) или на слух прилипла лишняя буква ("Grover" = to Rover);
            # иначе это другое имя (Qinglong — не Huanglong).
            if key[0] != low[0] and not _similar_initials(low, key) and fuzz.ratio(low[1:], key) < 90:
                continue
            if not core[0].isupper():
                need = 75
            elif key[0] == low[0] and abs(len(key) - len(low)) <= 1:
                need = 50
            else:
                need = 61
            if score >= need and score > best_score:
                best, best_score = spelled, score
        if best and best.lower() == low + "s" and re.match(r"['’]s\b", tail):
            # Ranger's -> Rangers' (а не Rangers's).
            result.append(head + best + tail[0] + tail[2:])
        else:
            result.append(head + best + tail if best else token)
    return " ".join(result)


def plan(project: str, start: int, server: str):
    project_dir = ROOT / "data" / project
    fragments = api(server, f"/api/p/{project}/manifest")["fragments"]
    source = load_source_lines(project_dir / "transcript.txt")
    anchors = locate_anchors(fragments, start, source)
    terms = proper_nouns(source)
    known = known_words(source)

    anchor_indices = sorted(anchors)
    all_anchors = [line for found in anchors.values() for line in found] or [0]
    first_anchor, last_anchor = min(all_anchors), max(all_anchors)
    speakers = {speaker for speaker, _ in source if speaker}
    changes = []
    for index in range(start, len(fragments)):
        fragment = fragments[index]
        if fragment["status"] != "active" or fragment.get("exported"):
            continue
        lines = [line for line in fragment["text"].split("\n") if line.strip()]
        if not any(not _SPEAKER_LINE.match(line.strip()) for line in lines):
            continue
        before = [i for i in anchor_indices if i < index]
        after = [i for i in anchor_indices if i > index]
        # Опоры самого фрагмента (если часть строк уже из источника) сужают окно.
        own = anchors.get(index, [])
        # До первой / после последней опоры источник может быть чужим (сцены,
        # которых нет в источнике, — например, бой в конце акта): ищем только
        # в EDGE_LINES репликах от крайней опоры, а не по всему источнику.
        low = min(own) if own else (anchors[before[-1]][-1] if before else max(0, first_anchor - EDGE_LINES))
        high = max(own) if own else (anchors[after[0]][0] if after else min(len(source) - 1, last_anchor + EDGE_LINES))
        if own:
            low = min(low, anchors[before[-1]][-1]) if before else low
            high = max(high, anchors[after[0]][0]) if after else high
        if high < low:
            low, high = high, low
        # Опора могла лечь на соседнюю реплику (похожие фразы) — окно с запасом.
        low, high = max(0, low - WINDOW_MARGIN), min(len(source) - 1, high + WINDOW_MARGIN)

        # Термины — те, что встречаются в репликах рядом (чтобы "Baija" стал
        # Baizhi, о которой тут говорят, а не похожим именем из другой главы).
        nearby = {w.lower().strip("'’-") for _, t in source[max(0, low - 30): high + 31]
                  for w in re.findall(r"[A-Za-z][A-Za-z'’-]*", t)}
        local_terms = {k: v for k, v in terms.items() if k in nearby}

        new_lines, scores, notes = [], [], []
        for line in lines:
            if _SPEAKER_LINE.match(line.strip()):
                new_lines.append(line)
                continue
            found = best_piece(line, source, low, high)
            # Короткие строки ("It.", "Seven.") похожи на что угодно — для них
            # нужно почти полное совпадение.
            short = len(_norm(line)) < 15
            strong = found and found[0] >= (SHORT_SCORE if short else STRONG_SCORE)
            if strong:
                new_lines.append(found[1])
                scores.append(found[0])
                continue
            # В источнике этой версии реплики нет (или она слишком короткая,
            # чтобы узнать уверенно): текст на слух, но имена и термины — как
            # в источнике, и говорящий — тот, чья реплика рядом больше похожа.
            # Продолжение незаконченного предложения — тот же говорящий, что в
            # предыдущей строке (этого фрагмента или предыдущего).
            previous = new_lines[-1] if new_lines else previous_line(fragments, index)
            prev_match = _SPEAKER_LINE.match(previous.strip()) if previous else None
            continues = prev_match and (line.strip()[:1].islower() or not re.search(r"[.!?…]['\"”’)]*$", previous.strip()))
            # Кого называют по имени ("What do you think, Rover?") — тот не говорит.
            addressed = {w.lower() for w in re.findall(r"[A-Za-z]+", fix_terms(line, local_terms, known))}
            # "I'm Jianxin" — говорит сам Jianxin.
            intro = re.search(r"\bI(?:'m|’m| am) ([A-Z][A-Za-z]+)", fix_terms(line, local_terms, known))
            if intro and intro.group(1) in speakers:
                speaker = intro.group(1)
            elif continues and prev_match.group(1).lower() not in addressed:
                speaker = prev_match.group(1)
            elif found and found[0] >= 50 and ":" in found[1] and found[1].split(":", 1)[0].lower() not in addressed:
                speaker = found[1].split(":", 1)[0]
            else:
                speaker = nearest_speaker(fragments, index, addressed)
            fixed = fix_terms(line.strip(), local_terms, known)
            new_lines.append(f"{speaker}: {fixed}" if speaker else fixed)
            notes.append(f"нет в источнике, говорящий угадан: {speaker}")
        # Подряд идущие строки одного говорящего из одной реплики не дублируются.
        deduped = []
        for line in new_lines:
            if not deduped or deduped[-1] != line:
                deduped.append(line)
        new_text = "\n".join(deduped)
        if new_text == fragment["text"]:
            continue
        old_text = fragment["text"]
        # Дальше соседи видят уже исправленный текст (говорящий по контексту).
        fragment["text"] = new_text
        weak = [s for s in scores if s < 75]
        if weak:
            notes.append(f"похожесть с источником {min(weak):.0f}%")
        changes.append((index, fragment["id"], old_text, new_text, bool(notes), "; ".join(notes), (low, high)))
    return changes, source


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Строки на слух — заменить репликами из источника.")
    parser.add_argument("--project", required=True)
    parser.add_argument("--from", dest="start", type=int, default=1, help="С какого фрагмента (номер в редакторе)")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--report", default=None, help="Файл для полного списка изменений")
    parser.add_argument("--server", default="http://127.0.0.1:8000")
    parser.add_argument("--mark-heard", action="store_true",
                        help="Только отметить голубым строки на слух у готовых фрагментов")
    parser.add_argument("--polish", action="store_true",
                        help="Оформить тексты: заглавные, точка в конце, парные кавычки")
    parser.add_argument("--fill-missing", action="store_true",
                        help="Вставить прозвучавшие, но пропавшие из текста слова (голубым)")
    parser.add_argument("--rebase-ids", default=None,
                        help="Файл с id фрагментов, чей текст поставил алгоритм (станет исходным)")
    args = parser.parse_args()
    server = args.server.rstrip("/")

    if args.polish:
        polish_existing(args.project, args.start, server, args.apply, args.report)
        return
    if args.fill_missing:
        fill_missing(args.project, args.start, server, args.apply, args.report)
        return
    if args.mark_heard:
        rebase_ids = set(Path(args.rebase_ids).read_text(encoding="utf-8").split()) if args.rebase_ids else set()
        mark_existing(args.project, args.start, server, rebase_ids, args.apply)
        return

    changes, source = plan(args.project, args.start - 1, server)
    report = []
    for index, _, old_text, new_text, review, note, window in changes:
        report.append(f"№{index + 1} (реплики {window[0] + 1}–{window[1] + 1})"
                      f"{' [проверить: ' + note + ']' if review else ''}\n"
                      f"  было:  {old_text!r}\n  стало: {new_text!r}")
    if args.report:
        Path(args.report).write_text("\n".join(report), encoding="utf-8")
    print(f"Изменений: {len(changes)}, на проверку: {sum(c[4] for c in changes)}")
    if not args.apply:
        return
    for index, fragment_id, _, new_text, review, note, _ in changes:
        body = {"text": new_text}
        if review:
            body.update(needs_review=True, review_note=note)
        try:
            api(server, f"/api/p/{args.project}/fragments/{fragment_id}", "PATCH", body)
            # Правка алгоритма — не ручная: текст становится исходным, а строки
            # на слух отмечаются голубым.
            ranges = heard_ranges(new_text, source_index(source))
            api(server, f"/api/p/{args.project}/fragments/{fragment_id}/heard", "POST",
                {"ranges": ranges, "rebase": True})
        except urllib.error.HTTPError as error:
            print(f"№{index + 1}: сервер ответил {error.code}: {error.read().decode('utf-8', 'replace')[:300]}")
    print("Готово.")


def source_index(source: list[tuple[str | None, str]]) -> list[str]:
    """Нормализованные реплики источника (с пробелами по краям — для поиска целых слов)."""
    return [f" {_norm(text)} " for _, text in source]


def heard_ranges(text: str, index: list[str]) -> list[list[int]]:
    """
    Строки текста, которых нет в источнике, — записанные на слух: диапазоны
    символов этих строк целиком (вместе с "Имя: " — говорящий у них тоже
    угадан). Строка из источника — её текст (без имени) целиком входит в
    какую-то реплику источника.
    """
    ranges = []
    position = 0
    for line in text.split("\n"):
        match = _SPEAKER_LINE.match(line.strip())
        body = _norm(match.group(2) if match else line)
        if body and not any(f" {body} " in s for s in index):
            ranges.append([position, position + len(line)])
        position += len(line) + 1
    return ranges


def mark_existing(project: str, start: int, server: str, rebase_ids: set[str], apply: bool) -> None:
    """
    Отметить голубым строки на слух у уже готовых фрагментов (с номера start).
    Фрагменты, текст которых правили вручную (text != original_text), не
    трогаются — кроме rebase_ids: их текст поставил алгоритм, он становится
    исходным.
    """
    fragments = api(server, f"/api/p/{project}/manifest")["fragments"]
    index = source_index(load_source_lines(ROOT / "data" / project / "transcript.txt"))
    marked = 0
    for number, fragment in enumerate(fragments, 1):
        if number < start or fragment["status"] != "active" or fragment.get("exported"):
            continue
        rebase = fragment["id"] in rebase_ids and fragment["text"] != fragment["original_text"]
        if fragment["text"] != fragment["original_text"] and not rebase:
            continue
        ranges = heard_ranges(fragment["text"], index)
        if ranges == fragment.get("heard_ranges", []) and not rebase:
            continue
        marked += bool(ranges)
        if apply:
            api(server, f"/api/p/{project}/fragments/{fragment['id']}/heard", "POST",
                {"ranges": ranges, "rebase": rebase})
    print(f"Фрагментов со строками на слух: {marked}")


# Слова-паразиты и междометия: если их нет в тексте, это не потеря.
_FILLERS = {"uh", "um", "umm", "hmm", "hm", "mm", "ah", "oh", "huh", "eh", "er", "mhm"}


def missing_words(text: str, heard: list[dict], terms: dict[str, str], known: set[str]):
    """
    Слова, которые прозвучали (heard — слова ASR в границах фрагмента), но
    которых в тексте нет совсем. Сравнение нечёткое (Jinjo ~ Jinzhou), без
    имён говорящих. Берутся только ЧИСТЫЕ пропуски: между двумя совпавшими
    местами в тексте нет ничего несовпавшего. Если там стоит другая версия
    фразы ("It's ... and a" против "It is ... as well as"), это не пропуск,
    а другая формулировка, и её не трогаем.
    Возвращает [(позиция вставки в text, вставляемый текст, в начало строки?)].
    """
    from phase1_ingest.source_text import _fuzzy_pairs, _norm as word_norm

    # Слова текста с позициями, без "Имя: " в начале строк.
    text_words = []  # (начало, конец, нормализованное, начало тела строки?)
    position = 0
    for line in text.split("\n"):
        match = _SPEAKER_LINE.match(line)
        body_start = position + (len(match.group(1)) + 2 if match else 0)
        first = True
        for m in re.finditer(r"\S+", text[body_start: position + len(line)]):
            text_words.append((body_start + m.start(), body_start + m.end(), word_norm(m.group(0)), first))
            first = False
        position += len(line) + 1
    heard_tokens = [word_norm(w["word"]) for w in heard]
    pairs = _fuzzy_pairs(heard_tokens, [w[2] for w in text_words])

    inserts = []
    bounds = [(-1, -1), *pairs, (len(heard), len(text_words))]
    for (a0, b0), (a1, b1) in zip(bounds, bounds[1:]):
        gap = [w for w in heard[a0 + 1: a1]]
        if not gap or b1 - b0 > 1:
            continue  # нечего вставлять или в тексте тут другая формулировка
        if all(word_norm(w["word"]) in _FILLERS or not word_norm(w["word"]) for w in gap):
            continue
        # Распознавание делит одно слово на части ("all right" = alright,
        # "Yang Yang" = Yangyang, "girl puffs" = Gulpuffs, "check -up"): если
        # пропуск вместе с соседним совпавшим словом похож на слово текста —
        # это не пропуск.
        # Повтор соседнего слова ("right right", "With With") — эхо
        # распознавания или порядок слов другой, а не пропуск.
        nearby = {text_words[k][2] for k in range(max(0, b0 - 1), min(len(text_words), b1 + 2))}
        if any(word_norm(w["word"]) in nearby for w in gap):
            continue
        glued = "".join(word_norm(w["word"]) for w in gap)
        if a0 >= 0 and b0 >= 0 and fuzz.ratio(heard_tokens[a0] + glued, text_words[b0][2].replace("-", "")) >= 70:
            continue
        if a1 < len(heard) and b1 < len(text_words) and fuzz.ratio(glued + heard_tokens[a1], text_words[b1][2].replace("-", "")) >= 70:
            continue
        # Пропуск в конце, после последнего совпавшего слова, — чаще всего
        # это начало следующей фразы, залезшее через границу; не трогаем.
        if b1 == len(text_words) and a1 == len(heard) and b0 >= 0:
            continue
        words = fix_terms(" ".join(w["word"].strip() for w in gap), terms, known)
        if b1 < len(text_words) and (b0 < 0 or text_words[b1][3]):
            # Перед первым совпавшим словом строки: в начало тела строки.
            inserts.append((text_words[b1][0], words, True))
        elif b0 >= 0:
            inserts.append((text_words[b0][1], words, False))
    return inserts


def polish_existing(project: str, start: int, server: str, apply: bool, report_path: str | None) -> None:
    """
    Оформить тексты готовых фрагментов (заглавные, точка в конце, парные
    кавычки — common/text_polish.py) с номера start. Только фрагменты, которые
    не правились вручную (text == original_text); правка алгоритма становится
    исходным текстом, голубые отметки переносятся.
    """
    from common.manifest_schema import carry_ranges
    from common.text_polish import polish_text

    fragments = api(server, f"/api/p/{project}/manifest")["fragments"]
    report, changed = [], 0
    for number, fragment in enumerate(fragments, 1):
        if number < start or fragment["status"] != "active" or fragment.get("exported"):
            continue
        text = fragment["text"]
        if not text.strip() or text != fragment["original_text"]:
            continue
        new_text = polish_text(text)
        if new_text == text:
            continue
        changed += 1
        report.append(f"№{number}\n  было:  {text!r}\n  стало: {new_text!r}")
        if apply:
            ranges = carry_ranges(text, new_text, fragment.get("heard_ranges", []))
            api(server, f"/api/p/{project}/fragments/{fragment['id']}", "PATCH", {"text": new_text})
            api(server, f"/api/p/{project}/fragments/{fragment['id']}/heard", "POST",
                {"ranges": ranges, "rebase": True})
    if report_path:
        Path(report_path).write_text("\n".join(report), encoding="utf-8")
    print(f"Оформлено фрагментов: {changed}")


def fill_missing(project: str, start: int, server: str, apply: bool, report_path: str | None) -> None:
    """
    Вставить в текст прозвучавшие, но пропавшие слова (голубым — на слух).
    Трогаются только фрагменты, которые не правились вручную
    (text == original_text), с номера start.
    """
    import json

    from phase1_ingest import segment as segment_mod
    from common.manifest_schema import carry_ranges

    project_dir = ROOT / "data" / project
    manifest = api(server, f"/api/p/{project}/manifest")
    fragments, fps = manifest["fragments"], manifest["video"]["fps"]
    words = segment_mod.flatten_words(json.loads((project_dir / "raw" / "whisper_transcript.json").read_text(encoding="utf-8")))
    source = load_source_lines(project_dir / "transcript.txt")
    terms, known = proper_nouns(source), known_words(source)

    report, changed = [], 0
    for number, fragment in enumerate(fragments, 1):
        if number < start or fragment["status"] != "active" or fragment.get("exported"):
            continue
        text = fragment["text"]
        if not text.strip() or text != fragment["original_text"]:
            continue
        low, high = fragment["algo_start_frame"] / fps, fragment["algo_end_frame"] / fps
        heard = [w for w in words if low <= (w["start"] + w["end"]) / 2 < high]
        inserts = missing_words(text, heard, terms, known)
        if not inserts:
            continue
        new_text, added = text, []
        for at, piece, line_start in sorted(inserts, reverse=True):
            piece = piece[:1].upper() + piece[1:] if line_start else piece
            chunk = piece + " " if line_start else " " + piece
            if line_start and not re.search(r"[.!?…]$", piece):
                # Бывшее первое слово строки теперь не первое: "Yeah, you know",
                # а не "Yeah, You know" (имена и "I" остаются с заглавной).
                following = re.match(r"[A-Za-z']+", new_text[at:])
                if following and following.group(0).lower() not in terms and not re.match(r"I\b|I'", following.group(0)):
                    new_text = new_text[:at] + new_text[at].lower() + new_text[at + 1:]
            new_text = new_text[:at] + chunk + new_text[at:]
            # Уже добавленные (правее) сдвигаются на длину вставки.
            added = [[a + len(chunk), b + len(chunk)] for a, b in added]
            added.append([at, at + len(piece)] if line_start else [at + 1, at + len(chunk)])
        ranges = carry_ranges(text, new_text, fragment.get("heard_ranges", [])) + added
        changed += 1
        report.append(f"№{number}\n  было:  {text!r}\n  стало: {new_text!r}\n  прозвучало: {' '.join(w['word'].strip() for w in heard)!r}")
        if apply:
            api(server, f"/api/p/{project}/fragments/{fragment['id']}", "PATCH", {"text": new_text})
            api(server, f"/api/p/{project}/fragments/{fragment['id']}/heard", "POST",
                {"ranges": ranges, "rebase": True})
    if report_path:
        Path(report_path).write_text("\n".join(report), encoding="utf-8")
    print(f"Фрагментов с пропавшими словами: {changed}")


if __name__ == "__main__":
    main()
