# -*- coding: utf-8 -*-
"""
Источник текста для сверки (transcript.txt): реплики "Имя: текст" этого видео.

Режимы (окно видео в "Обработке"):
  - без агента — только ссылки пользователя;
  - "deep" (глубокий поиск) — ссылки пользователя как отправная точка +
    агент ищет нужные страницы по ним и рядом, при нехватке — и в других местах;
  - "search" — агент сам ищет достоверные источники, ссылки не нужны.

Как работает:
  1. агент (модель OpenRouter с веб-поиском, модель — из настроек
     "search_model") по названию видео и репликам из распознанной речи
     находит страницы с полным текстом реплик и возвращает ссылки;
  2. страницы скачиваются: Notion — через NotionReader (страница и её
     подстраницы/строки базы), остальные сайты — как HTML; из текста берутся
     реплики "Имя: текст";
  3. каждый источник проверяется по распознанной речи — какую долю фраз видео
     он покрывает, — и обрезается до куска, который соответствует видео
     (сюжетная глава в Notion обычно шире одного видео);
  4. лучший источник (при нехватке покрытия — ещё один) пишется в
     transcript.txt, найденные ссылки — в project.json ("found_sources").
"""
import html
import json
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

from media_study.core.progress import report

from . import notion

MAX_SOURCES = 5
# Имя героя-игрока на вики, где его реплики (варианты ответа) помечены иконкой.
PLAYER_BY_SITE = {"wutheringwaves.fandom.com": "Rover"}
# Строка источника "есть в видео", если такая доля её пар слов прозвучала.
LINE_MATCH = 0.5
MIN_PAIRS = 3  # короче — реплика слишком общая, чтобы что-то доказывать
MISS_SCORE = -0.3  # штраф за реплику источника, которой нет в видео
CLUSTER_PAD = 15  # запас реплик до и после найденного куска
# Если лучший источник покрывает меньше этой доли фраз видео — добавляется следующий.
GOOD_COVERAGE = 0.6

COMMON_PROMPT = """Ты – агент поиска текстовых источников. Пользователь учит английский по видео (часто – прохождения сюжета игр) и для каждого видео ему нужен ТОЧНЫЙ текст всех реплик с именами говорящих: сценарий или транскрипт, опубликованный в интернете. По нему программа сверит распознанную речь – имена, названия и термины должны быть написаны правильно.

Что искать:
- страницы, где выложен полный текст диалогов именно этого контента (этого акта, главы, квеста, эпизода) – реплики подряд, в формате «Имя: реплика»;
- лучше всего: архивы сценариев (в т.ч. на Notion), страницы «Transcript»/«Script»/«Dialogue» на фан-вики, официальные публикации; хуже – пересказы, гайды без реплик, субтитры без имён (такие не бери);
- давай ПРЯМЫЕ ссылки на страницы с текстом (страницу главы/квеста или базу Notion, где лежат страницы сцен), а не на поисковую выдачу и не на главную сайта;
- проверяй, что источник покрывает реплики из видео (сравни с примерами реплик ниже);
- ищи настойчиво: сделай несколько разных запросов (название акта/квеста, название главы, точные цитаты из реплик в кавычках); архивы сценариев часто называют страницы по главам («Chapter 1: …»), а не по актам или названию видео – открывай оглавления и подстраницы.

Ответ – только JSON:
{"sources": [{"url": "...", "title": "...", "why": "почему это тот самый текст", "covers": "что именно покрывает (главы/сцены)"}], "note": "кратко: что нашёл, чего не хватает"}
Не больше 5 источников, самые надёжные – первыми. Если ничего подходящего нет – пустой список и объяснение в note."""

SEARCH_PROMPT = """РЕЖИМ: самостоятельный поиск. Ссылок от пользователя нет – найди достоверные источники сам по названию видео, каналу и репликам."""

GAP_PROMPT = """РЕЖИМ: поиск недостающих реплик. Основной источник уже найден, но в нём нет части реплик, которые звучат в видео (их список ниже – распознанная речь, с ошибками распознавания). Эти реплики ТОЧНО где-то опубликованы – не сдавайся и не отвечай «не нашёл», пока не попробовал всё:
- ищи по точным цитатам в кавычках (по 2–3 разные цитаты; убирай явные ошибки распознавания, ищи по уцелевшим словам);
- в архивах сценариев (Notion и т.п.) этот кусок может лежать на странице с другим названием: соседняя глава, «Chapter N: …», интерлюдия, побочный/компаньон-квест, сюжетное событие – открывай оглавление архива и подстраницы;
- страницы отдельных сцен, локаций, персонажей (раздел Dialogue/Quotes), страницы событий, другие вики по этой игре/шоу;
- давай ПРЯМЫЕ ссылки на страницы, где есть эти реплики.
Ссылки из списка «уже проверено» не возвращай – там этих реплик нет."""

# Пропуски основного источника: сколько ненайденных реплик речи (каждая не
# короче MIN_PAIRS пар слов) стоит отдельного запроса агенту.
GAP_QUERY_MIN = 3
GAP_QUERY_SAMPLES = 15
# Сколько раз подряд спрашивать агента про оставшиеся пропуски: каждый раунд –
# другие цитаты и список уже проверенных ссылок; раунд ничего не добавил – хватит.
GAP_ROUNDS = 4

DEEP_PROMPT = """РЕЖИМ: глубокий поиск. Пользователь дал ссылки – это отправная точка (часто это сборник сценариев, где лежит и этот контент, и много другого). Твоя задача:
1. разобраться, что по этим ссылкам: какие страницы/подстраницы/главы соответствуют ИМЕННО этому видео (по названию акта/квеста и по репликам);
2. вернуть самые точные ссылки (ссылки пользователя тоже, если они подходят целиком);
3. если по ссылкам текст неполный – найти недостающее в других местах."""


# -- скачивание и разбор источников ---------------------------------------------------

class _TextBlocks(HTMLParser):
    """Текст HTML по блокам (абзацы, строки таблиц, пункты списков) — по строке на блок."""

    BLOCKS = {"p", "div", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6", "dd", "dt", "blockquote", "section"}
    # audio — внутри плеера реплики (Fandom) ссылка на звуковой файл, это не текст.
    SKIP = {"script", "style", "noscript", "nav", "footer", "header", "audio"}

    def __init__(self, player: str = ""):
        super().__init__()
        self.lines, self.current, self.skip = [], [], 0
        # Иконка "вариант ответа игрока" (вики игр) -> реплика героя (player).
        self.player = player

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        if tag in self.BLOCKS:
            self.flush()
        if tag == "img" and self.player and "Dialogue Talk" in dict(attrs).get("alt", "") and not self.skip:
            self.current.append(f"{self.player}: ")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        if tag in self.BLOCKS:
            self.flush()

    def handle_data(self, data):
        if not self.skip:
            self.current.append(data)

    def flush(self):
        text = " ".join("".join(self.current).split())
        if text:
            self.lines.append(text)
        self.current = []


def _dialogue(lines: list[str]) -> list[str]:
    from media_study.core.text_clean import clean_text

    result = []
    for text in lines:
        # Сначала чистка: реплики героя на вики записаны шаблоном
        # "(RoverThe player's chosen name for Rover): …" – до чистки строка
        # начинается со скобки и не узнавалась как реплика (терялись все
        # реплики Ровера).
        parsed = notion.dialogue_line(clean_text(text))
        if parsed:
            result.append(f"{parsed[0]}: {parsed[1]}")
    return result


def _plain(lines) -> list[str]:
    """
    Строки текста песни (для аудио): у текстов песен нет "Имя:", поэтому
    берутся все строки с буквами, кроме пометок частей ("[Chorus]",
    "(Verse 2)") и слишком длинных абзацев (описания, комментарии). Лишнее
    вокруг потом отрезает trim_to_video – по совпадению с распознанной речью.
    """
    import re as _re

    from media_study.core.text_clean import clean_text

    result = []
    for text in lines:
        line = clean_text(text).strip()
        if not line or len(line) > 200 or not _re.search(r"[A-Za-zА-Яа-яЁё]", line):
            continue
        if _re.fullmatch(r"[\[(].*[\])]", line):
            continue  # [Chorus], (Verse 2: …)
        result.append(line)
    return result


def fetch_lines(url: str, log=print, plain: bool = False) -> list[str]:
    """
    Реплики "Имя: текст" со страницы (Notion — со всеми подстраницами/строками
    базы); plain – просто строки текста (песни у аудио, см. _plain).
    """
    pick = _plain if plain else _dialogue
    if "notion.site" in url or "notion.so" in url:
        reader = notion.NotionReader(notion.site_of(url))
        root = notion.page_id_from_url(url)
        pages = [root] + [bid for _, kind, _, bid in reader.outline(root, max_depth=0) if kind == "page"]
        lines = []
        for n, page_id in enumerate(pages, 1):
            if n % 50 == 0:
                log(f"  {url[:60]}…: страниц {n}/{len(pages)}")
            lines += reader.page_lines(page_id)
        return pick(lines)
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) media-study/1.0"}
    wiki = re.match(r"(https?://[^/]+)/wiki/([^?#]+)", url)
    if wiki:
        # Вики на MediaWiki (Fandom и т.п.) закрывают обычное скачивание страниц
        # (403), но отдают тот же текст через api.php (action=parse).
        api = wiki.group(1) + "/api.php?" + urllib.parse.urlencode(
            {"action": "parse", "page": urllib.parse.unquote(wiki.group(2)), "prop": "text", "format": "json",
             "formatversion": 2})
        with urllib.request.urlopen(urllib.request.Request(api, headers=headers), timeout=60) as response:
            page = json.loads(response.read().decode("utf-8"))["parse"]["text"]
    else:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
            page = response.read().decode(response.headers.get_content_charset() or "utf-8", errors="replace")
    # Вики, где варианты ответа игрока помечены иконкой, а не именем.
    player = next((name for site, name in PLAYER_BY_SITE.items() if site in url), "")
    parser = _TextBlocks(player)
    parser.feed(page)
    parser.flush()
    return pick([html.unescape(line) for line in parser.lines])


# -- проверка по распознанной речи ------------------------------------------------------

def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def _pairs(words: list[str]) -> set:
    return {(a, b) for a, b in zip(words, words[1:])}


def asr_pairs(whisper_transcript: dict) -> set:
    from ..segment import flatten_words

    return _pairs(_words(" ".join(w["word"] for w in flatten_words(whisper_transcript))))


def line_scores(lines: list[str], heard: set) -> list[float]:
    """
    Оценка каждой реплики источника для поиска куска видео: прозвучала (+1),
    не прозвучала (MISS_SCORE); короткие реплики (меньше MIN_PAIRS пар слов —
    "Are you alright?" есть почти в любой главе) не в счёт (0).
    """
    scores = []
    for line in lines:
        pairs = _pairs(_words(line.split(": ", 1)[-1]))
        if len(pairs) < MIN_PAIRS:
            scores.append(0.0)
        else:
            scores.append(1.0 if sum(p in heard for p in pairs) / len(pairs) >= LINE_MATCH else MISS_SCORE)
    return scores


def trim_to_video(lines: list[str], heard: set) -> tuple[list[str], int]:
    """
    Кусок источника, который соответствует видео: участок подряд идущих
    реплик с наибольшей суммой оценок (самый плотный по совпадениям; задача о
    максимальном подотрезке) с запасом CLUSTER_PAD. Возвращает (реплики,
    сколько в куске совпавших).
    """
    scores = line_scores(lines, heard)
    best, best_range, current, start = 0.0, None, 0.0, 0
    for i, score in enumerate(scores):
        if current <= 0:
            current, start = 0.0, i
        current += score
        if current > best:
            best, best_range = current, (start, i)
    if best_range is None:
        return [], 0
    first, last = best_range
    hits = sum(1 for sc in scores[first:last + 1] if sc > 0)
    return lines[max(0, first - CLUSTER_PAD): min(len(lines), last + CLUSTER_PAD + 1)], hits


def coverage(lines: list[str], heard: set) -> float:
    """Какая доля фраз видео (пар слов речи) есть в источнике."""
    have = set()
    for line in lines:
        have |= _pairs(_words(line.split(": ", 1)[-1]))
    return len(heard & have) / len(heard) if heard else 0.0


# -- недостающие реплики из других источников ----------------------------------------

def _segments(whisper_transcript: dict) -> list[dict]:
    """Фразы распознанной речи по порядку: {start, text, pairs}."""
    result = []
    for seg in whisper_transcript.get("segments", []):
        text = (seg.get("text") or "").strip()
        pairs = _pairs(_words(text))
        if text and pairs:
            result.append({"start": seg.get("start", 0.0), "text": text, "pairs": pairs})
    return result


def _line_pairs(line: str) -> set:
    return _pairs(_words(line.split(": ", 1)[-1]))


def _best_line(segment_pairs: set, lines: list[str], pairs_of: list[set]) -> int | None:
    """Строка, где больше всего пар слов фразы (не меньше LINE_MATCH от фразы)."""
    best, best_share = None, 0.0
    for k, pairs in enumerate(pairs_of):
        if not pairs:
            continue
        share = len(segment_pairs & pairs) / len(segment_pairs)
        if share > best_share:
            best, best_share = k, share
    return best if best_share >= LINE_MATCH else None


def missing_segments(lines: list[str], whisper_transcript: dict) -> list[dict]:
    """Фразы речи (не короче MIN_PAIRS пар), которых в репликах lines нет."""
    pairs_of = [_line_pairs(line) for line in lines]
    return [seg for seg in _segments(whisper_transcript)
            if len(seg["pairs"]) >= MIN_PAIRS and _best_line(seg["pairs"], lines, pairs_of) is None]


def fill_gaps(main: list[str], others: list[list[str]], whisper_transcript: dict) -> tuple[list[str], int]:
    """
    Реплики речи, которых нет в основном источнике, ищутся в других
    источниках; найденная строка вставляется на своё место по времени — после
    реплики основного источника, совпавшей с предыдущей фразой речи.
    Возвращает (реплики, сколько вставлено).
    """
    main = list(main)
    main_pairs = [_line_pairs(line) for line in main]
    other_lines = [line for lines in others for line in lines]
    other_pairs = [_line_pairs(line) for line in other_lines]
    # Для каждой фразы речи: строка основного источника (индекс) или вставка.
    anchor = -1  # последняя совпавшая строка основного источника
    inserts: dict[int, list[str]] = {}
    taken = set(main)
    added = 0
    for seg in _segments(whisper_transcript):
        if len(seg["pairs"]) < MIN_PAIRS:
            continue
        k = _best_line(seg["pairs"], main, main_pairs)
        if k is not None:
            anchor = max(anchor, k)
            continue
        j = _best_line(seg["pairs"], other_lines, other_pairs)
        if j is None or other_lines[j] in taken:
            continue
        taken.add(other_lines[j])
        inserts.setdefault(anchor, []).append(other_lines[j])
        added += 1
    if not added:
        return main, 0
    result = list(inserts.get(-1, []))
    for k, line in enumerate(main):
        result.append(line)
        result.extend(inserts.get(k, []))
    return result, added


# -- агент ---------------------------------------------------------------------------

def _samples(whisper_transcript: dict) -> str:
    """Примеры реплик из распознанной речи: начало, середина, конец."""
    segments = [s["text"].strip() for s in whisper_transcript.get("segments", []) if s.get("text", "").strip()]
    if not segments:
        return "(речь не распознана)"
    picked = segments[:25] + ["…"] + segments[len(segments) // 2: len(segments) // 2 + 10] + ["…"] + segments[-10:]
    return "\n".join(picked)


def ask_agent(data_dir: Path, project_dir: Path, mode: str, links: list[str], whisper_transcript: dict,
              missing: list[str] | None = None) -> dict:
    """Запрос к модели поиска (с веб-поиском OpenRouter). Возвращает {"sources": [...], "note": ...}."""
    from media_study.web.library import app_settings, title_of, video_info, group_of
    from media_study.export.translator import _post, parse_answer

    info = video_info(project_dir)
    model = app_settings(data_dir).get("search_model") or "anthropic/claude-sonnet-5.5"
    user = (
        f"Видео: {title_of(project_dir)}\nКанал/автор: {info.get('channel') or info.get('uploader') or '—'}\n"
        f"Группа в приложении: {group_of(project_dir)}\nДлительность: {round((info.get('duration') or 0) / 60)} мин\n"
        f"Ссылка: {info.get('webpage_url') or '—'}\n\n"
    )
    if info.get("audio_only"):
        # Песня (или подкаст/аудиокнига): нужен её текст – lyrics, по куплетам и
        # припевам, со всеми повторами; имён говорящих у песни обычно нет.
        user = ("Тип: АУДИО (скорее всего песня). Нужен полный текст (lyrics) этой записи со всеми повторами "
                "припевов; формат «Имя: реплика» не обязателен – подойдут строки текста песни.\n" + user)
    if mode == "deep":
        user += "Ссылки пользователя:\n" + ("\n".join(links) or "—") + "\n\n"
    if missing:
        user += ("Основной источник: " + links[0] + "\n\nУже проверено (этих реплик там нет):\n" + "\n".join(links) +
                 "\n\nРеплики видео, которых ни в одном источнике нет:\n" + "\n".join(missing))
    else:
        user += "Примеры реплик из распознанной речи видео (с ошибками распознавания):\n" + _samples(whisper_transcript)
    body = {
        "model": model,
        "messages": [{"role": "system", "content": COMMON_PROMPT + "\n\n" + (
            GAP_PROMPT if missing else DEEP_PROMPT if mode == "deep" else SEARCH_PROMPT)},
                     {"role": "user", "content": user}],
        "plugins": [{"id": "web", "max_results": 10}],
        "temperature": 0.2,
        "max_tokens": 2000,
        "usage": {"include": True},
    }
    reply = _post(data_dir, "/chat/completions", body)
    answer = parse_answer(reply["choices"][0]["message"]["content"])
    answer["cost"] = float((reply.get("usage") or {}).get("cost") or 0)
    answer["model"] = model
    return answer


def build_transcript(project_dir: Path, whisper_transcript: dict, log=print) -> bool:
    """
    transcript.txt для видео по его настройкам (ссылки, режим агента).
    Возвращает, записан ли текст.
    """
    from media_study.web.library import add_cost, agent_mode, project_settings, save_project_settings, video_info

    project_dir = Path(project_dir)
    data_dir = project_dir.parent
    # Аудио (песни): текст – строками без "Имя:" (см. _plain).
    plain = bool(video_info(project_dir).get("audio_only"))
    settings = project_settings(project_dir)
    mode = agent_mode(settings.get("agent"))
    links = [u for u in settings.get("sources", []) if u.strip()]
    candidates = [] if mode == "search" else [{"url": u, "title": "ссылка пользователя"} for u in links]
    note = ""
    if mode in ("deep", "search"):
        log(f"Агент ищет источники ({'глубокий поиск' if mode == 'deep' else 'самостоятельно'})…")
        try:
            # В "Сейчас идёт" видно, что работает агент (поиск – минута-другая).
            report(project_dir, "agent_search", None, force=True)
            answer = ask_agent(data_dir, project_dir, mode, links, whisper_transcript)
            report(project_dir, "search", None, force=True)
            add_cost(project_dir, "search", answer.get("cost", 0))
            note = answer.get("note", "")
            log(f"Агент: {note} (${answer.get('cost', 0):.4f})")
            known = {c["url"] for c in candidates}
            for source in answer.get("sources", [])[:MAX_SOURCES]:
                if source.get("url") and source["url"] not in known:
                    candidates.append(source)
                    known.add(source["url"])
        except Exception as error:  # нет денег/сети — обходимся ссылками пользователя
            log(f"Агент не смог: {error}")
    heard = asr_pairs(whisper_transcript)
    checked = []
    for source in candidates:
        try:
            lines = fetch_lines(source["url"], log, plain)
        except Exception as error:
            log(f"  {source['url']}: не скачалось ({error})")
            continue
        trimmed, hits = trim_to_video(lines, heard)
        share = coverage(trimmed, heard)
        log(f"  {source['url']}: реплик {len(lines)}, по видео {len(trimmed)}, покрытие {share:.0%}")
        checked.append({**source, "lines": trimmed, "coverage": share})
    checked = [c for c in checked if c["lines"]]
    checked.sort(key=lambda c: -c["coverage"])
    used = checked[:1]
    lines = list(checked[0]["lines"]) if checked else []
    if checked:
        # Реплики речи, которых нет в основном источнике, — точечно из других
        # найденных источников (на своё место по времени).
        lines, added = fill_gaps(lines, [c["lines"] for c in checked[1:]], whisper_transcript)
        if added:
            log(f"  Недостающие реплики из других источников: {added}")
            used += [c for c in checked[1:] if any(line in lines for line in c["lines"])]
        # Всё ещё много не найдено, и агент включён — спрашивать его именно про
        # них, несколько раундов (каждый раз – другие цитаты и уже проверенные
        # ссылки), пока раунды что-то добавляют.
        idle = 0
        for round_no in range(1, GAP_ROUNDS + 1):
            missing = missing_segments(lines, whisper_transcript)
            if len(missing) < GAP_QUERY_MIN or mode not in ("deep", "search"):
                break
            # Цитаты – вразброс по всему видео, каждый раунд со сдвигом.
            step = max(1, len(missing) // GAP_QUERY_SAMPLES)
            quotes = [seg["text"] for seg in missing[round_no - 1::step]][:GAP_QUERY_SAMPLES]
            log(f"  Не найдено реплик: {len(missing)} — агент ищет их отдельно (раунд {round_no})…")
            try:
                report(project_dir, "agent_search", None, force=True)
                tried = [checked[0]["url"]] + [c["url"] for c in checked[1:]]
                gap_answer = ask_agent(data_dir, project_dir, mode, tried, whisper_transcript, missing=quotes)
                report(project_dir, "search", None, force=True)
                add_cost(project_dir, "search", gap_answer.get("cost", 0))
                log(f"  Агент: {gap_answer.get('note', '')} (${gap_answer.get('cost', 0):.4f})")
                extra = []
                for source in gap_answer.get("sources", [])[:MAX_SOURCES]:
                    if not source.get("url") or any(source["url"] == c["url"] for c in checked + extra):
                        continue
                    try:
                        extra_lines = fetch_lines(source["url"], log, plain)
                    except Exception as error:
                        log(f"  {source['url']}: не скачалось ({error})")
                        continue
                    extra.append({**source, "lines": extra_lines, "coverage": coverage(extra_lines, heard)})
                lines, added = fill_gaps(lines, [c["lines"] for c in extra], whisper_transcript)
                log(f"  Ещё добавлено из найденного агентом: {added}")
                checked += extra
                used += [c for c in extra if any(line in lines for line in c["lines"])]
                # Два раунда подряд впустую (другие цитаты тоже не помогли) – хватит.
                idle = 0 if added else idle + 1
                if idle >= 2:
                    break
            except Exception as error:
                log(f"  Агент не смог: {error}")
                break
    settings["found_sources"] = [{"url": c["url"], "title": c.get("title", ""), "coverage": round(c["coverage"], 3),
                                  "used": c in used} for c in checked]
    if note:
        settings["search_note"] = note
    save_project_settings(project_dir, settings)
    if not used:
        return False
    # Чистка строк (невидимые символы, шаблон имени героя с вики и т.п.).
    from media_study.core.text_clean import clean_text

    lines = [clean_text(line) for line in lines if clean_text(line)]
    (project_dir / "transcript.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return True
