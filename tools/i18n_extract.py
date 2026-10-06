# -*- coding: utf-8 -*-
"""
Сбор русских строк интерфейса для перевода (английский интерфейс).

Перевод в приложении – слоем поверх страницы (static/i18n.js): словарь
"русская фраза -> перевод" (static/i18n/en.js) подменяет текст, подсказки и
плейсхолдеры по мере появления. Этот скрипт собирает фразы, которых в
словаре ещё нет:
  - из JS/HTML интерфейса – строковые литералы с кириллицей; в шаблонах
    `...${expr}...` вставки становятся {0}, {1}…, HTML-теги режут фразу на
    куски (каждый кусок – отдельный текстовый узел на странице);
  - из Python веб-части и обработки – строки, которые уходят в интерфейс
    (ошибки, статусы, этапы): литералы с кириллицей вне комментариев и
    докстрингов; в f-строках {expr} -> {0}…

Запуск: py -3.12 -m tools.i18n_extract  ->  tools/i18n_missing.txt (фраза в строке).
"""
from __future__ import annotations

import io
import json
import re
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "media_study" / "web" / "static"
CYR = re.compile(r"[А-Яа-яЁё]")
TAG = re.compile(r"<[^>]*>")
ENTITY = {"&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&laquo;": "«", "&raquo;": "»"}


def norm(s: str) -> str:
    for k, v in ENTITY.items():
        s = s.replace(k, v)
    return re.sub(r"\s+", " ", s).strip()


def js_literals(code: str):
    """Строковые литералы JS ('…', "…", `…`), без комментариев."""
    i, n = 0, len(code)
    while i < n:
        c = code[i]
        if c == "/" and code[i:i + 2] == "//":
            i = code.find("\n", i)
            i = n if i < 0 else i
            continue
        if c == "/" and code[i:i + 2] == "/*":
            j = code.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in "'\"`":
            j, buf, depth = i + 1, [], 0
            while j < n:
                ch = code[j]
                if ch == "\\":
                    buf.append(code[j:j + 2])
                    j += 2
                    continue
                if c == "`" and code[j:j + 2] == "${":
                    # вставка – до парной } (с учётом вложенных)
                    k, depth = j + 2, 1
                    while k < n and depth:
                        depth += {"{": 1, "}": -1}.get(code[k], 0)
                        k += 1
                    buf.append("\x00")
                    j = k
                    continue
                if ch == c:
                    break
                buf.append(ch)
                j += 1
            yield c, "".join(buf)
            i = j + 1
            continue
        i += 1


def phrases_from_text(raw: str, template: bool) -> list[str]:
    out = []
    raw = raw.replace("\\n", "\n").replace("\\'", "'").replace('\\"', '"')
    for piece in TAG.split(raw):
        if not CYR.search(piece):
            continue
        k = 0

        def hole(_m):
            nonlocal k
            k += 1
            return "{" + str(k - 1) + "}"

        text = re.sub("\x00", hole, piece) if template else piece
        text = norm(text)
        # Подсказки в атрибутах: title="…" placeholder="…" – отдельно.
        if text and CYR.search(text):
            out.append(text)
    return out


def js_strings(path: Path) -> list[tuple[str, str]]:
    """Литералы через настоящий разбор JS (tools/i18n_js_strings.js, acorn); нет node – запасной разбор."""
    import os
    import subprocess

    try:
        out = subprocess.run(["node", str(ROOT / "tools" / "i18n_js_strings.js"), str(path)], capture_output=True,
                             text=True, encoding="utf-8", env={**os.environ, "ACORN_DIR": os.environ.get("ACORN_DIR", "")}, check=True)
        return [("`", s) for s in json.loads(out.stdout)]
    except (OSError, subprocess.CalledProcessError, ValueError):
        return list(js_literals(path.read_text(encoding="utf-8")))


def from_js(path: Path) -> set[str]:
    found = set()
    for quote, body in js_strings(path):
        if not CYR.search(body):
            continue
        # Атрибуты внутри HTML-строк.
        for m in re.finditer(r'(?:title|placeholder|aria-label)="([^"]*[А-Яа-яЁё][^"]*)"', body):
            found.update(phrases_from_text(m.group(1), quote == "`"))
        body = re.sub(r'(?:title|placeholder|aria-label)="[^"]*"', "", body)
        found.update(phrases_from_text(body, quote == "`"))
    return found


def from_html(path: Path) -> set[str]:
    html = path.read_text(encoding="utf-8")
    html = re.sub(r"<!--.*?-->", "", html, flags=re.S)
    html = re.sub(r"<script.*?</script>", "", html, flags=re.S)
    found = set()
    for m in re.finditer(r'(?:title|placeholder|aria-label)="([^"]*)"', html):
        found.update(phrases_from_text(m.group(1), False))
    found.update(phrases_from_text(re.sub(r'(?:title|placeholder|aria-label)="[^"]*"', "", html), False))
    return found


def from_python(path: Path) -> set[str]:
    found = set()
    src = path.read_text(encoding="utf-8")
    prev_type = None
    for tok in tokenize.generate_tokens(io.StringIO(src).readline):
        if tok.type == tokenize.STRING:
            s = tok.string
            # Докстринги: строка сразу после ":"/NEWLINE/INDENT в начале блока – пропустить.
            if prev_type in (tokenize.INDENT, tokenize.NEWLINE, None) and s.lstrip("rbfuRBFU").startswith(('"""', "'''")):
                prev_type = tok.type
                continue
            if CYR.search(s):
                body = re.sub(r"^[rbfuRBFU]*('''|\"\"\"|'|\")", "", s)
                body = re.sub(r"('''|\"\"\"|'|\")$", "", body)
                if s.lstrip("rbuRBU").lower().startswith("f"):
                    k = 0

                    def hole(_m):
                        nonlocal k
                        k += 1
                        return "{" + str(k - 1) + "}"

                    body = re.sub(r"\{[^{}]*\}", hole, body)
                for line in body.split("\\n"):
                    t = norm(line)
                    if t and CYR.search(t) and len(t) < 300:
                        found.add(t)
        if tok.type not in (tokenize.COMMENT, tokenize.NL):
            prev_type = tok.type
    return found


def load_dict() -> dict:
    path = STATIC / "i18n-en.js"
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    body = text.split("window.I18N_DICT.en =", 1)[1].rsplit(";", 1)[0]
    return json.loads(body)


def main() -> None:
    found: set[str] = set()
    for f in STATIC.glob("*.js"):
        if f.name.startswith("i18n"):  # сам переводчик и словарь
            continue
        found |= from_js(f)
    found |= from_html(STATIC / "index.html")
    for rel in ("media_study/web/server.py", "media_study/web/library.py", "media_study/web/storage.py",
                "media_study/core/progress.py", "media_study/ingest/cli.py", "media_study/ingest/build_manifest.py",
                "media_study/export/worker.py", "media_study/export/agent.py", "media_study/export/translator.py",
                "media_study/ingest/speech/elevenlabs.py", "media_study/ingest/speech/whisper_models.py",
                "media_study/ingest/acquire.py", "media_study/packs.py"):
        found |= from_python(ROOT / rel)
    known = load_dict()
    missing = sorted(p for p in found if p not in known)
    out = ROOT / "tools" / "i18n_missing.txt"
    out.write_text("\n".join(missing) + "\n", encoding="utf-8")
    print(f"фраз найдено: {len(found)}, без перевода: {len(missing)} -> {out}")


if __name__ == "__main__":
    main()
