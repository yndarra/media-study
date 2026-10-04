# -*- coding: utf-8 -*-
"""
Эксперимент: один и тот же кусок видео переводят разные модели (как в
настоящем переводе — пачками с полным текстом видео), результаты — рядом.
В Anki и в предложения агента ничего не пишется.

  py -3.12 -m tools.translate_experiment --project EtVj-LuPFl4 --share 0.1 \\
      --models anthropic/claude-sonnet-5.5 google/gemini-3.8-flash

Результат: data/experiments/<время>/results.json и report.html (таблица:
реплика — перевод каждой модели; внизу — стоимость и время).
"""
import argparse
import html
import json
import sys
import time
from datetime import datetime
from pathlib import Path

from media_study.core.manifest import Manifest, STATUS_ACTIVE
from media_study.export import translator

ROOT = Path(__file__).resolve().parent.parent


def experiment_cards(project_dir: Path, share: float, start_share: float) -> list[dict]:
    """Подряд идущий кусок видео (доля share от фрагментов с текстом, начиная с start_share)."""
    manifest = Manifest.load(project_dir / "manifest.json")
    numbered = [(k, f) for k, f in enumerate(manifest.fragments) if f.status == STATUS_ACTIVE and f.text.strip()]
    begin = int(len(numbered) * start_share)
    piece = numbered[begin: begin + max(1, int(len(numbered) * share))]
    cards = []
    for k, f in piece:
        plain = "\n".join(line.split(": ", 1)[1] if ": " in line else line for line in f.text.split("\n"))
        cards.append({"id": f"{k + 1:04d}", "note_id": k + 1, "fragment_id": f.id, "flag": 0, "project": project_dir.name,
                      "front_old": "", "back_old": "", "front_new": "", "text": plain, "speaker_text": f.text,
                      "back_text": "", "comments": []})
    return cards


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Сравнение моделей перевода на куске видео.")
    parser.add_argument("--project", required=True)
    parser.add_argument("--share", type=float, default=0.1, help="Доля видео (фрагментов с текстом)")
    parser.add_argument("--start", type=float, default=0.0, help="С какой доли видео начать")
    parser.add_argument("--models", nargs="+", required=True)
    args = parser.parse_args()

    data_dir = ROOT / "data"
    project_dir = data_dir / args.project
    cards = experiment_cards(project_dir, args.share, args.start)
    transcript, _ = translator.video_transcript(project_dir, number_all=True)
    out_dir = data_dir / "experiments" / datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Карточек: {len(cards)} ({cards[0]['id']}–{cards[-1]['id']}), пачек: {len(translator.chunks(cards))}", flush=True)

    results = {"project": args.project, "cards": cards, "models": {}}
    for model in args.models:
        started = time.time()
        glossary: dict = {}
        proposals, cost = translator.translate_realtime(data_dir, project_dir, cards, model, transcript=transcript,
                                                        glossary=glossary)
        results["models"][model] = {
            "cost": round(cost, 4), "seconds": round(time.time() - started),
            "glossary": glossary,
            "by_card": {p["card_number"]: {"back": p["back_new"], "answer": p["answer"]} for p in proposals},
        }
        print(f"{model}: {len(proposals)} переводов, ${cost:.4f}, {time.time() - started:.0f} с", flush=True)
        (out_dir / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    models = list(results["models"])
    rows = []
    for card in cards:
        cells = "".join(f"<td>{results['models'][m]['by_card'].get(card['id'], {}).get('back', '—')}</td>" for m in models)
        rows.append(f"<tr><td class='n'>#{card['id']}</td><td class='en'>{html.escape(card['speaker_text']).replace(chr(10), '<br>')}</td>{cells}</tr>")
    head = "".join(f"<th>{html.escape(m)}<br><small>${results['models'][m]['cost']} · {results['models'][m]['seconds']} с</small></th>" for m in models)
    (out_dir / "report.html").write_text(
        "<!doctype html><meta charset='utf-8'><title>Сравнение переводов</title>"
        "<style>body{font:14px Segoe UI,sans-serif;background:#111;color:#ddd}table{border-collapse:collapse}"
        "td,th{border:1px solid #333;padding:6px;vertical-align:top}td.en{color:#9cf;max-width:340px}td.n{color:#888}"
        "ul{margin:4px 0 0 16px;padding:0}</style>"
        f"<table><tr><th></th><th>Реплика</th>{head}</tr>{''.join(rows)}</table>", encoding="utf-8")
    print(f"Готово: {out_dir}", flush=True)


if __name__ == "__main__":
    main()
