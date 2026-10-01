# -*- coding: utf-8 -*-
"""
Оформление текста карточки: каждая строка — законченная фраза.

Фрагмент часто начинается или кончается посреди предложения источника
(фразу режут по паузам речи), поэтому без доводки строки выглядят как
"with me. and that strange..." или "and now," — без заглавной в начале,
без точки в конце, с непарной кавычкой (кавычка открылась в одном
фрагменте, закрылась в соседнем). Правила для каждой строки ("Имя: текст" —
правится только текст после имени):

Строки одного говорящего подряд — одна реплика (на этапе 3 они и так
склеиваются в одну строку): заглавная — в начале первой из них, знак конца —
в конце последней, а перенос строки между ними предложение не обрывает.

1. Первая буква реплики — заглавная (кроме явного продолжения: реплика
   начинается с многоточия или тире); после конца предложения (. ! ?) —
   тоже заглавная. После многоточия — не трогаем (там часто продолжение
   фразы: "And... that strange"), после сокращений (Mr., Dr., ...) — тоже.
2. В конце — знак конца: строка без знака получает точку; запятая, точка
   с запятой, двоеточие в конце заменяются точкой. Многоточие, ?, !,
   тире (оборванная речь) остаются как есть.
3. Кавычки парные: к непарной открывающей в конце добавляется закрывающая,
   к непарной закрывающей в начале — открывающая. Апострофы внутри слов
   (don't, Rover's), притяжательные (Rangers') и просторечные (searchin',
   'round, 'em) кавычками не считаются.
"""
import re

_SPEAKER = re.compile(r"^([A-Z][\w .'’-]{0,50}): (.*)$")
# Сокращения, после точки которых предложение не кончается.
_ABBREVIATIONS = {"mr", "mrs", "ms", "dr", "st", "vs", "etc", "jr", "sr", "no", "e.g", "i.e"}
_END_MARKS = ".!?…"
_DASHES = "-–—"
# Закрывающие кавычки/скобки, за которыми может стоять знак конца.
_TRAILING = "\"'”’)»"


# Просторечные сокращения с апострофом в начале слова.
_LEADING_ELISIONS = {"round", "em", "cause", "til", "bout", "tis", "twas", "n"}


def _capitalize_sentences(text: str, first: bool = True) -> str:
    chars = list(text)
    # Первая буква реплики (если это не явное продолжение: "...", "–").
    if first and not re.match(r"^\s*(\.\.\.|…|[-–—])", text):
        for i, ch in enumerate(chars):
            if ch.isalpha():
                chars[i] = ch.upper()
                break
            if ch.isdigit():
                break
    # После . ! ? (не многоточия и не сокращения) — заглавная.
    for match in re.finditer(r"([.!?])([\"'”’)»]*)(\s+)([\"'“‘(«]*)([a-z])", text):
        end_mark_at = match.start(1)
        if text[end_mark_at] == "." and (text[end_mark_at - 1: end_mark_at] == "." or text[end_mark_at + 1: end_mark_at + 2] == "."):
            continue  # многоточие "..."
        word = re.search(r"([A-Za-z.]+)$", text[:end_mark_at])
        if text[end_mark_at] == "." and word and word.group(1).lower().rstrip(".") in _ABBREVIATIONS:
            continue
        letter_at = match.start(5)
        chars[letter_at] = chars[letter_at].upper()
    return "".join(chars)


def _end_sentence(text: str) -> str:
    text = text.rstrip()
    core = text.rstrip(_TRAILING)
    tail = text[len(core):]
    if not core:
        return text
    last = core[-1]
    if last in _END_MARKS or last in _DASHES:
        return text
    if last in ",;:":
        core = core[:-1].rstrip()
    return core + "." + tail


def _is_apostrophe(text: str, i: int) -> bool:
    """
    ' или ’ — апостроф, а не кавычка: внутри слова (don't), притяжательное
    (Rangers'), просторечное окончание (searchin', chattin') или начало
    ('round, 'em).
    """
    before = text[i - 1] if i > 0 else " "
    after = text[i + 1] if i + 1 < len(text) else " "
    if before.isalnum() and after.isalnum():
        return True
    if not after.isalnum() and i > 1 and text[i - 2].isalpha():
        if before in "sS" or text[i - 2: i].lower() == "in":
            return True
    word = re.match(r"[A-Za-z]+", text[i + 1:])
    return not before.strip() and bool(word) and word.group(0).lower() in _LEADING_ELISIONS


def _balance_quotes(text: str) -> str:
    # Прямые двойные: нечётное число — одна лишняя/непарная.
    if text.count('"') % 2:
        i = text.index('"') if text.count('"') == 1 else text.rindex('"')
        after = text[i + 1] if i + 1 < len(text) else " "
        if after.strip():  # открывающая — закрываем в конце
            text = text + '"'
        else:  # закрывающая — открываем в начале
            text = '"' + text
    # Типографские двойные.
    opened, closed = text.count("“"), text.count("”")
    if opened > closed:
        text = text + "”" * (opened - closed)
    elif closed > opened:
        text = "“" * (closed - opened) + text
    # Одинарные: открывающие — ‘ и ' в начале слова; закрывающие — ’ и ' в
    # конце слова (кроме апострофов).
    openers, closers = [], []
    for i, ch in enumerate(text):
        if ch not in "'‘’" or (ch != "‘" and _is_apostrophe(text, i)):
            continue
        before = text[i - 1] if i > 0 else " "
        after = text[i + 1] if i + 1 < len(text) else " "
        if ch == "‘" or (ch == "'" and not before.strip() and after.isalpha()):
            openers.append(ch)
        elif before.strip() and not after.isalnum():
            closers.append(ch)
    if len(openers) > len(closers):
        text = text + ("’" if openers[-1] == "‘" else "'") * (len(openers) - len(closers))
    elif len(closers) > len(openers):
        text = ("‘" if closers[0] == "’" else "'") * (len(closers) - len(openers)) + text
    return text


def polish_lines(bodies: list[str]) -> list[str]:
    """
    Одна реплика, разбитая на строки (без имени говорящего): заглавные во
    всех строках по предложениям, но в начале — только у первой; знак
    конца — только у последней; кавычки балансируются по реплике целиком.
    """
    bodies = [b.strip() for b in bodies]
    if not any(re.search(r"[A-Za-z0-9]", b) for b in bodies):
        return bodies  # "...", "—" и т.п. — не трогаем
    out = [_capitalize_sentences(b, first=(k == 0)) for k, b in enumerate(bodies)]
    out[-1] = _end_sentence(out[-1])
    # Кавычки — по всей реплике: склеиваем через "\n" и балансируем вместе.
    return _balance_quotes("\n".join(out)).split("\n")


def polish_line(body: str) -> str:
    """Одна фраза (без имени говорящего) по правилам модуля."""
    return polish_lines([body])[0]


def polish_text(text: str) -> str:
    """
    Текст фрагмента: строки "Имя: текст" (или просто текст) группируются в
    реплики — подряд идущие строки одного говорящего — и оформляются по правилам.
    """
    runs: list[tuple[str | None, list[str]]] = []
    for line in text.split("\n"):
        if not line.strip():
            continue
        match = _SPEAKER.match(line.strip())
        speaker, body = (match.group(1), match.group(2)) if match else (None, line)
        if runs and runs[-1][0] == speaker and speaker is not None:
            runs[-1][1].append(body)
        else:
            runs.append((speaker, [body]))
    lines = []
    for speaker, bodies in runs:
        for body in polish_lines(bodies):
            lines.append(f"{speaker}: {body}" if speaker else body)
    return "\n".join(lines)
