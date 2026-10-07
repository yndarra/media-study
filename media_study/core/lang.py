# -*- coding: utf-8 -*-
"""
Языки: на каком языке речь в видео (язык речи) и на какой язык переводятся
карточки (язык карточек).

По умолчанию – из настроек (отдельно для видео и аудио: speech_lang_video /
speech_lang_audio; card_lang – общий), у видео можно задать свои
(project.json: speech_lang, card_lang). От языка речи зависят распознавание
(Whisper), выбор субтитров YouTube, склейка слов (японский, китайский,
корейский – без пробелов) и оформление текста (заглавные/точки – только у
языков с заглавными буквами); от пары языков – подсказка переводчику.
"""
from __future__ import annotations

import re
from pathlib import Path

# код -> (название, родительный "с …", винительный "на …"/"учит …", English)
LANGS = {
    "en": ("Английский", "английского", "английский", "English"),
    "ru": ("Русский", "русского", "русский", "Russian"),
    "ja": ("Японский", "японского", "японский", "Japanese"),
    "zh": ("Китайский", "китайского", "китайский", "Chinese"),
    "ko": ("Корейский", "корейского", "корейский", "Korean"),
    "de": ("Немецкий", "немецкого", "немецкий", "German"),
    "fr": ("Французский", "французского", "французский", "French"),
    "es": ("Испанский", "испанского", "испанский", "Spanish"),
    "it": ("Итальянский", "итальянского", "итальянский", "Italian"),
    "pt": ("Португальский", "португальского", "португальский", "Portuguese"),
    "uk": ("Украинский", "украинского", "украинский", "Ukrainian"),
}
# Письменность без пробелов между словами.
NO_SPACE_LANGS = {"ja", "zh"}
# Без заглавных букв (оформление текста "заглавная + точка" не нужно).
NO_CASE_LANGS = {"ja", "zh", "ko"}
_CJK = re.compile(r"[぀-ヿ㐀-鿿豈-﫿＀-￯　-〿]")


def name(code: str) -> str:
    return LANGS.get(code, (code,))[0]


def genitive(code: str) -> str:
    return LANGS.get(code, (code, code))[1]


def accusative(code: str) -> str:
    return LANGS.get(code, (code, code, code))[2]


def english_name(code: str) -> str:
    return LANGS.get(code, (code, code, code, code))[3]


def join_words(words) -> str:
    """
    Слова в текст: через пробел, а между иероглифами/каной – без него (в
    японском и китайском пробелов нет; распознавание отдаёт слова отдельно).
    Для английского – то же самое, что " ".join(words).
    """
    out = ""
    for w in words:
        w = str(w)
        if not w:
            continue
        if out and not (_CJK.search(out[-1]) and _CJK.search(w[0])):
            out += " "
        out += w
    return out


def join_texts(a: str, b: str) -> str:
    """Два куска текста подряд (с пробелом или без – как join_words)."""
    return join_words([t for t in (a, b) if t])


def has_case(code: str) -> bool:
    return code not in NO_CASE_LANGS


def speech_lang(project_dir: Path) -> str:
    """Язык речи видео: свой (project.json) или по умолчанию для видео/аудио."""
    from media_study.web.library import app_settings, project_settings, video_info

    project_dir = Path(project_dir)
    own = project_settings(project_dir).get("speech_lang")
    if own:
        return own
    settings = app_settings(project_dir.parent)
    kind = "audio" if video_info(project_dir).get("audio_only") else "video"
    return settings.get(f"speech_lang_{kind}") or "en"


def card_lang(project_dir: Path) -> str:
    """Язык карточек (на какой переводить): свой или по умолчанию."""
    from media_study.web.library import app_settings, project_settings

    project_dir = Path(project_dir)
    return project_settings(project_dir).get("card_lang") or app_settings(project_dir.parent).get("card_lang") or "ru"
