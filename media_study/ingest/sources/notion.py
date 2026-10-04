# -*- coding: utf-8 -*-
"""
Чтение публичных страниц Notion (например, wutheringwaves.notion.site) как
источника текста для сверки.

Публичная страница Notion собирается скриптом в браузере, поэтому текст
берётся из того же внутреннего API, которым пользуется сама страница
(/api/v3/loadCachedPageChunk): он отдаёт блоки страницы — абзацы,
заголовки, подстраницы — в JSON. Подстраницы читаются отдельными запросами.
"""
from __future__ import annotations

import json
import re
import time
import urllib.request

USER_AGENT = "Mozilla/5.0 (media-study)"
_ID_RE = re.compile(r"([0-9a-f]{32})(?:[?#]|$)")


def page_id_from_url(url: str) -> str:
    """Идентификатор страницы из ссылки ...-0123456789abcdef0123456789abcdef."""
    match = _ID_RE.search(url.split("?")[0] + "?")
    if not match:
        raise ValueError(f"в ссылке нет идентификатора страницы Notion: {url}")
    raw = match.group(1)
    return f"{raw[:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:]}"


def site_of(url: str) -> str:
    match = re.match(r"(https://[^/]+)", url)
    return match.group(1) if match else "https://www.notion.so"


class NotionReader:
    def __init__(self, site: str):
        self.api = site.rstrip("/") + "/api/v3/"
        self.blocks: dict[str, dict] = {}
        self.views: dict[str, dict] = {}  # виды баз данных (collection_view)
        self.space_id: str | None = None  # пространство сайта — нужно в запросах публичного доступа

    def _post(self, endpoint: str, payload: dict) -> dict:
        request = urllib.request.Request(
            self.api + endpoint, data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        )
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    return json.loads(response.read().decode("utf-8"))
            except OSError as error:
                if attempt == 3 or getattr(error, "code", None) in (400, 403, 404):
                    raise
                time.sleep(2 * (attempt + 1))
        return {}

    def load_page(self, page_id: str) -> None:
        """Все блоки страницы (порциями, пока Notion отдаёт продолжение)."""
        cursor = {"stack": []}
        chunk = 0
        while True:
            data = self._post("loadCachedPageChunk", {
                "page": {"id": page_id}, "limit": 100, "cursor": cursor, "chunkNumber": chunk, "verticalColumns": False,
            })
            self._remember(data.get("recordMap", {}))
            cursor = data.get("cursor", {"stack": []})
            chunk += 1
            if not cursor.get("stack"):
                return

    @staticmethod
    def _unwrap(record: dict) -> dict:
        value = record.get("value", {})
        return value.get("value", value) if isinstance(value, dict) else {}  # новый формат — двойная обёртка

    def _remember(self, record_map: dict) -> None:
        for block_id, record in record_map.get("block", {}).items():
            self.space_id = self.space_id or record.get("spaceId") or self._unwrap(record).get("space_id")
            value = self._unwrap(record)
            if value:
                self.blocks[block_id] = value
        for view_id, record in record_map.get("collection_view", {}).items():
            value = self._unwrap(record)
            if value:
                self.views[view_id] = value

    def fetch(self, block_ids: list[str]) -> None:
        """Дозагрузить блоки, которых нет в ответе страницы (например, содержимое колонок)."""
        missing = [i for i in block_ids if i not in self.blocks]
        for start in range(0, len(missing), 50):
            pointers = [{"table": "block", "id": i, **({"spaceId": self.space_id} if self.space_id else {})}
                        for i in missing[start:start + 50]]
            try:
                data = self._post("syncRecordValues", {"requests": [{"pointer": ptr, "version": -1} for ptr in pointers]})
                self._remember(data.get("recordMap", {}))
            except OSError:
                # Запасной путь: блок с вложенным содержимым грузится как страница.
                for block_id in missing[start:start + 50]:
                    try:
                        self.load_page(block_id)
                    except OSError:
                        pass

    def block(self, block_id: str) -> dict:
        return self.blocks.get(block_id, {})

    @staticmethod
    def text(block: dict) -> str:
        return "".join(part[0] for part in block.get("properties", {}).get("title", []))

    def children(self, block_id: str) -> list[dict]:
        ids = self.block(block_id).get("content", [])
        self.fetch(ids)
        return [self.block(c) for c in ids if self.block(c)]

    def collection_rows(self, block: dict) -> list[dict]:
        """Строки встроенной базы данных Notion (каждая строка — подстраница)."""
        view_ids = block.get("view_ids") or []
        if not view_ids:
            return []
        if view_ids[0] not in self.views:
            data = self._post("syncRecordValues", {"requests": [
                {"pointer": {"table": "collection_view", "id": view_ids[0]}, "version": -1}]})
            self._remember(data.get("recordMap", {}))
        # У связанной базы адрес самой базы — в записи её вида.
        collection_id = block.get("collection_id") or self.views.get(view_ids[0], {}).get("format", {}).get("collection_pointer", {}).get("id")
        if not collection_id:
            return []
        data = self._post("queryCollection", {
            "collection": {"id": collection_id},
            "collectionView": {"id": view_ids[0]},
            "loader": {"type": "reducer", "reducers": {"collection_group_results": {"type": "results", "limit": 500}},
                       "searchQuery": "", "userTimeZone": "UTC"},
        })
        record_map = data.get("recordMap", {}).get("block", {})
        rows = []
        ids = data.get("result", {}).get("reducerResults", {}).get("collection_group_results", {}).get("blockIds", [])
        for row_id in ids:
            value = record_map.get(row_id, {}).get("value", {})
            value = value.get("value", value)
            if value:
                self.blocks[row_id] = value
                rows.append(value)
        return rows

    def outline(self, page_id: str, depth: int = 0, max_depth: int = 1) -> list[tuple[int, str, str, str]]:
        """(уровень, тип, текст, id) — дерево страницы с подстраницами до max_depth."""
        if page_id not in self.blocks:
            self.load_page(page_id)
        rows = []

        def walk(block_id: str, level: int) -> None:
            for child in self.children(block_id):
                kind = child.get("type", "")
                rows.append((level, kind, self.text(child), child.get("id", "")))
                if kind == "page":
                    if level < max_depth:
                        rows.extend(self.outline(child["id"], level + 1, max_depth))
                elif kind in ("collection_view", "collection_view_page"):
                    for row in self.collection_rows(child):
                        rows.append((level + 1, "page", self.text(row), row.get("id", "")))
                        if level + 1 < max_depth:
                            rows.extend(self.outline(row["id"], level + 2, max_depth))
                elif child.get("content"):
                    # Колонки, переключатели и т.п. — их содержимое тоже часть страницы.
                    walk(child["id"], level + 1)

        walk(page_id, depth)
        return rows

    def page_lines(self, page_id: str) -> list[str]:
        """Весь текст страницы по порядку (без подстраниц), вложенные блоки — тоже."""
        if page_id not in self.blocks:
            self.load_page(page_id)
        lines = []

        def walk(block_id: str) -> None:
            for child in self.children(block_id):
                if child.get("type") == "page":
                    continue
                text = self.text(child).strip()
                if text:
                    lines.append(text)
                if child.get("content"):
                    walk(child["id"])

        walk(page_id)
        return lines


# -- реплики игровых сценариев -------------------------------------------------------

# "Имя: «реплика»" — в сценариях WuWa каждая реплика начинается с имени говорящего.
_DIALOGUE_RE = re.compile(r"^\s*([^:\n]{1,40}?)\s*:\s*(.+?)\s*$")
_QUOTES = "\"'“”„«»‘’"


def dialogue_line(text: str) -> tuple[str, str] | None:
    """(говорящий, реплика без кавычек) или None, если это не реплика."""
    match = _DIALOGUE_RE.match(text)
    if not match:
        return None
    speaker, line = match.group(1).strip(), match.group(2).strip()
    # Имя — короткое и с заглавной буквы; иначе это просто текст с двоеточием.
    # "???" — ещё не представившийся персонаж (так его показывает игра и вики).
    unknown = bool(re.fullmatch(r"\?{2,3}", speaker))
    if not speaker or not (speaker[0].isupper() or unknown) or len(speaker.split()) > 4:
        return None
    line = line.strip(_QUOTES).strip()
    return (speaker, line) if line else None


def chapter_transcript(url: str, start_title: str, stop_title: str | None = None) -> list[str]:
    """
    Реплики глав сценария по порядку, строками "Имя: реплика": страницы
    базы глав от start_title до stop_title включительно (трейлеры, разборы
    и т.п. до start_title пропускаются). Строки без говорящего (описания,
    пометки) отбрасываются — это "лишний текст" источника.
    """
    reader = NotionReader(site_of(url))
    root = page_id_from_url(url)
    pages = [(text, bid) for depth, kind, text, bid in reader.outline(root, max_depth=0) if kind == "page"]
    titles = [t for t, _ in pages]
    if start_title not in titles:
        raise ValueError(f"в оглавлении нет страницы «{start_title}»")
    begin = titles.index(start_title)
    end = titles.index(stop_title) + 1 if stop_title and stop_title in titles else len(pages)
    lines = []
    for title, page_id in pages[begin:end]:
        for text in reader.page_lines(page_id):
            parsed = dialogue_line(text)
            if parsed:
                lines.append(f"{parsed[0]}: {parsed[1]}")
    return lines
