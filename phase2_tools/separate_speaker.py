# -*- coding: utf-8 -*-
"""
Вспомогательный алгоритм этапа 2: реплики одного персонажа — в отдельные
фрагменты (сделано для Rover в Wuthering Waves: его реплики не озвучены —
это выбор ответа, — поэтому при нарезке по речи они прилипают к соседним
фразам, а в карточке они должны быть отдельно).

Для каждого фрагмента, начиная с --from (номер как в редакторе):
  - строки персонажа в НАЧАЛЕ текста (одна или несколько подряд) переносятся
    в конец текста соседнего слева фрагмента — если он пустой (без текста);
  - строки персонажа в КОНЦЕ текста — в начало соседнего справа, если он пустой;
  - строки персонажа посередине (между репликами других) не трогаются;
  - если подходящего пустого соседа нет — ничего не делается.
Фрагменты, уже переданные в Anki или удалённые, не трогаются. Весь текст
фрагмента, состоящий только из реплик этого персонажа, остаётся на месте.

Правки идут через сервер редактора (как ручные): у каждого фрагмента они
попадают в его историю и отменяются кнопкой "назад", и не конфликтуют с
параллельной работой в редакторе.

  py -3.12 -m phase2_tools.separate_speaker --project yiAxdzOQKG4 --speaker Rover --from 30 [--apply]
Без --apply — только показывает, что было бы сделано.
"""
import argparse
import json
import sys
import urllib.request

from common.manifest_schema import carry_ranges


def api(base: str, path: str, method: str = "GET", body: dict | None = None):
    request = urllib.request.Request(
        base + path, method=method,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def is_speaker_line(line: str, speaker: str) -> bool:
    return line.strip().startswith(f"{speaker}:")


def editable_empty(fragment: dict) -> bool:
    return fragment["status"] == "active" and not fragment.get("exported") and not fragment["text"].strip()


def plan_moves(fragments: list[dict], speaker: str, start: int) -> list[tuple[int, int, list[str], str]]:
    """Переносы: (откуда, куда, строки, "left"/"right") — по текущему состоянию, без изменений."""
    texts = [f["text"] for f in fragments]
    moves = []
    for i in range(start, len(fragments)):
        f = fragments[i]
        if f["status"] != "active" or f.get("exported"):
            continue
        lines = [line for line in texts[i].split("\n") if line.strip()]
        if not lines or all(is_speaker_line(line, speaker) for line in lines):
            continue
        head = 0
        while head < len(lines) and is_speaker_line(lines[head], speaker):
            head += 1
        tail = 0
        while tail < len(lines) - head and is_speaker_line(lines[len(lines) - 1 - tail], speaker):
            tail += 1
        if head and i > 0 and editable_empty(fragments[i - 1]) and not texts[i - 1].strip():
            moves.append((i, i - 1, lines[:head], "left"))
            texts[i - 1] = "\n".join(lines[:head])
            lines = lines[head:]
        if tail and i + 1 < len(fragments) and editable_empty(fragments[i + 1]) and not texts[i + 1].strip():
            moved = lines[len(lines) - tail:]
            moves.append((i, i + 1, moved, "right"))
            texts[i + 1] = "\n".join(moved)
            lines = lines[: len(lines) - tail]
        texts[i] = "\n".join(lines)
    return moves


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Реплики персонажа — в соседние пустые фрагменты.")
    parser.add_argument("--project", required=True)
    parser.add_argument("--speaker", default="Rover")
    parser.add_argument("--from", dest="start", type=int, default=1, help="С какого фрагмента (номер в редакторе)")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--server", default="http://127.0.0.1:8000")
    args = parser.parse_args()

    base = args.server.rstrip("/")
    manifest = api(base, f"/api/p/{args.project}/manifest")
    fragments = manifest["fragments"]
    moves = plan_moves(fragments, args.speaker, args.start - 1)
    for source, target, lines, side in moves:
        print(f"№{source + 1} -> №{target + 1} ({'влево' if side == 'left' else 'вправо'}): " + " / ".join(lines)[:120])
    print(f"Переносов: {len(moves)}")
    if not args.apply:
        return

    # Применяем по одному переносу: сначала пустой сосед получает строки, потом
    # исходный фрагмент их теряет (так текст нигде не пропадает даже при сбое).
    for source, target, lines, side in moves:
        manifest = api(base, f"/api/p/{args.project}/manifest")
        frags = manifest["fragments"]
        src, dst = frags[source], frags[target]
        if dst["text"].strip() or not editable_empty(dst):
            print(f"пропуск №{source + 1}: сосед №{target + 1} уже не пустой")
            continue
        src_lines = [line for line in src["text"].split("\n") if line.strip()]
        rest = src_lines[len(lines):] if side == "left" else src_lines[: len(src_lines) - len(lines)]
        api(base, f"/api/p/{args.project}/fragments/{dst['id']}", "PATCH", {"text": "\n".join(lines)})
        api(base, f"/api/p/{args.project}/fragments/{src['id']}", "PATCH", {"text": "\n".join(rest)})
        # Перенос сделал алгоритм, а не человек: новый текст становится
        # исходным — иначе фрагменты выглядят "правлеными", и скрытый прогресс
        # (последний изменённый фрагмент) убегает далеко вперёд.
        # Голубые отметки "на слух" переносятся на новый текст.
        current = {f["id"]: f for f in api(base, f"/api/p/{args.project}/manifest")["fragments"]}
        for fragment_id in (dst["id"], src["id"]):
            f = current[fragment_id]
            ranges = carry_ranges(f["original_text"], f["text"], f.get("heard_ranges", []))
            api(base, f"/api/p/{args.project}/fragments/{fragment_id}/heard", "POST", {"ranges": ranges, "rebase": True})
    print("Готово.")


if __name__ == "__main__":
    main()
