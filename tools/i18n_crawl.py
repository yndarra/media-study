# -*- coding: utf-8 -*-
"""
Обход приложения на английском: какие русские фразы остались без перевода
(I18n.missing). Только просмотр – ничего не нажимает из того, что меняет
данные (сохранение, передача, перевод, перенос отключены заглушками).

Запуск (сервер приложения запущен, нужен Playwright и Edge):
  py -3.12 -m tools.i18n_crawl  ->  tools/i18n_missing_runtime.txt
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:8000/"
BLOCK = ["**/agent/run", "**/agent/apply", "**/move", "**/move/cancel", "**/stage3/queue", "**/anki/return",
         "**/anki/recolor", "**/restart", "**/shutdown", "**/fragments/**", "**/settings"]


def main() -> None:
    missing: set[str] = set()
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        pg = b.new_page(viewport={"width": 1600, "height": 1000})
        pg.add_init_script("try { localStorage.setItem('ui-lang', 'en') } catch (e) {}")
        for pat in BLOCK:
            pg.route(pat, lambda r: r.continue_() if r.request.method == "GET" else r.fulfill(status=200, body="{}"))

        def harvest():
            pg.wait_for_timeout(1500)
            missing.update(pg.evaluate("[...I18n.missing]"))

        def visit(route):
            pg.goto(BASE + route)
            harvest()

        for mode in ("video", "audio"):
            pg.goto(BASE + "#/media")
            pg.wait_for_timeout(800)
            pg.evaluate(f"Mode.set('{mode}')")
            harvest()
            for route in ("#/media", "#/process", "#/add", "#/settings"):
                visit(route)
            visit("#/stats")
            for tab in ("costs", "info", "speed", "authors"):
                pg.click(f".tab-bar button[data-k={tab}]")
                harvest()
            pg.goto(BASE + "#/media")
            pg.wait_for_timeout(1500)
            hrefs = pg.eval_on_selector_all("#videos-list a.card", "as => as.map(a => a.getAttribute('href'))")
            for href in hrefs[:12]:
                visit(href)
                if pg.locator("#info-storage").count():
                    pg.click("#info-storage")
                    harvest()
                    pg.keyboard.press("Escape")
            pg.goto(BASE + "#/process")
            pg.wait_for_timeout(1500)
            for href in pg.eval_on_selector_all("#process-list a.card", "as => as.map(a => a.getAttribute('href'))")[:6]:
                visit(href)
        # Настройки: другой движок распознавания.
        visit("#/settings")
        pg.evaluate("(() => { const f = document.getElementById('set-asr'); f.value = 'elevenlabs'; f.dispatchEvent(new Event('input', {bubbles: true})); })()")
        harvest()
        # Журналы.
        pg.click("#server-log")
        harvest()
        for tab in pg.eval_on_selector_all(".log-tabs button, .log-tab", "bs => bs.length") and range(3) or []:
            pass
        pg.keyboard.press("Escape")
        # Редактор (просмотр).
        pg.goto(BASE + "#/media")
        pg.wait_for_timeout(1000)
        ids = pg.eval_on_selector_all("#videos-list a.card", "as => as.map(a => a.getAttribute('href').split('/').pop())")
        for vid in ids[:2]:
            visit(f"#/edit/{vid}")
            for key in ("d", "d", "a"):
                pg.keyboard.press(key)
                pg.wait_for_timeout(300)
            harvest()
        b.close()
    # Числа в форме {n} -> {0}, {1}… (как в словаре).
    out = set()
    for s in missing:
        k = 0

        def hole(_m):
            nonlocal k
            k += 1
            return "{" + str(k - 1) + "}"

        out.add(re.sub(r"\{n\}", hole, s))
    path = ROOT / "tools" / "i18n_missing_runtime.txt"
    path.write_text("\n".join(sorted(out)) + "\n", encoding="utf-8")
    print(f"без перевода на экране: {len(out)} -> {path}")


if __name__ == "__main__":
    main()
