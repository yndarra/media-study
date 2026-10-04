# -*- coding: utf-8 -*-
"""
Чистка текста фраз от "мусорных" пробелов.

Оформленные вручную субтитры YouTube бывают нашпигованы невидимыми
символами — пробелами нулевой ширины (U+200B) и родственными: авторы
вставляют их ради отступов и выравнивания. В тексте фразы они выглядят как
лишние пробелы и мешают править текст (каретка "спотыкается" о невидимое).

Правило чистки одно на все тексты (распознанный, из источника, введённый
пользователем): невидимые символы удаляются, любые подряд идущие пробелы
внутри строки сжимаются в один, каждая строка обрезается по краям, пустые
строки убираются. Переносы между непустыми строками остаются.
"""
import re

# Пробелы нулевой ширины, "склейки" и BOM — в тексте фразы они не нужны никогда.
_INVISIBLE_RE = re.compile("[\u200b\u200c\u200d\u2060\ufeff]")
# Шаблон имени героя с фан-вики: "(RoverThe player's chosen name for Rover)"
# (с невидимыми склейками внутри) — это просто "Rover".
_ROVER_TEMPLATE_RE = re.compile(r"\(?\s*Rover\s*The player[’']s chosen name for Rover\s*\)?")
# Любые горизонтальные пробелы (обычный, неразрывный, табуляция, узкие и т.п.).
_SPACES_RE = re.compile(r"[^\S\n]+")


_GLUED_DASH_RE = re.compile(r"\s*[—–]\s*")


def normalize_dashes(text: str | None) -> str:
    """
    Тире для карточек: длинное "—" не используется никогда — только короткое
    "–", и всегда с пробелами: "word—word" → "word – word", "—Wait" → "– Wait",
    "be—" → "be –". Дефис в словах ("Jian-xin") не трогается.
    """
    if not text:
        return ""
    lines = []
    for line in text.split("\n"):
        line = _GLUED_DASH_RE.sub(" – ", line).strip()
        lines.append(line)
    return "\n".join(lines)


def clean_text(text: str | None) -> str:
    if not text:
        return ""
    text = _INVISIBLE_RE.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))
    text = _ROVER_TEMPLATE_RE.sub("Rover", text)
    lines = [_SPACES_RE.sub(" ", line).strip() for line in text.split("\n")]
    # Пустые строки не нужны нигде: в начале и в конце это "висящие"
    # переносы, посередине — остатки строк, состоявших из одного мусора.
    return "\n".join(line for line in lines if line)
