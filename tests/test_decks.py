# -*- coding: utf-8 -*-
"""
Переименование колоды видео: карточки переезжают, пустая старая колода и
пустые родители удаляются, непустые и чужие (с подколодами) — никогда.
"""
import unittest
from unittest import mock

from media_study.export import anki, decks


class FakeAnki:
    def __init__(self, decks_cards: dict[str, list[int]], tagged: list[int]):
        self.cards = {name: list(ids) for name, ids in decks_cards.items()}  # колода -> карточки
        self.tagged = tagged
        self.deleted = []

    def ids(self):
        return {name: k + 1 for k, name in enumerate(self.cards)}

    def __call__(self, action, **params):
        if action == "findCards":
            q = params["query"]
            if q.startswith('"tag:'):
                return list(self.tagged)
            deck_id = int(q.split(":")[1])
            name = next(n for n, i in self.ids().items() if i == deck_id)
            return list(self.cards[name])
        if action == "createDeck":
            self.cards.setdefault(params["deck"], [])
            return 1
        if action == "changeDeck":
            for ids in self.cards.values():
                ids[:] = [c for c in ids if c not in params["cards"]]
            self.cards[params["deck"]] += params["cards"]
            return None
        if action == "deckNamesAndIds":
            return self.ids()
        if action == "deleteDecks":
            for name in params["decks"]:
                assert not self.cards[name], f"удаляется непустая колода {name}"
                del self.cards[name]
                self.deleted.append(name)
            return None
        raise AssertionError(action)


class TestMoveProject(unittest.TestCase):
    def test_rename_author_moves_cards_and_removes_empty_old(self):
        fake = FakeAnki({
            "Claude": [], "Claude::2. VIDEOS": [], "Claude::2. VIDEOS::MrBeast": [],
            "Claude::2. VIDEOS::MrBeast::Video": [1, 2, 3],
            "Claude::2. VIDEOS::Other": [], "Claude::2. VIDEOS::Other::Clip": [9],
        }, tagged=[1, 2, 3])
        with mock.patch.object(anki, "invoke", fake):
            moved = decks.move_project("p", "Claude::2. VIDEOS::MrBeast::Video", "Claude::2. VIDEOS::Mr Beast::Video")
        self.assertEqual(moved, 3)
        self.assertEqual(fake.cards["Claude::2. VIDEOS::Mr Beast::Video"], [1, 2, 3])
        # Старая колода и пустой автор удалены; общий корень и чужие — нет.
        self.assertEqual(fake.deleted, ["Claude::2. VIDEOS::MrBeast::Video", "Claude::2. VIDEOS::MrBeast"])
        self.assertIn("Claude::2. VIDEOS::Other::Clip", fake.cards)
        self.assertIn("Claude::2. VIDEOS", fake.cards)

    def test_parent_with_other_videos_is_kept(self):
        fake = FakeAnki({
            "Claude": [], "Claude::V": [], "Claude::V::A": [],
            "Claude::V::A::One": [1], "Claude::V::A::Two": [2],
        }, tagged=[1])
        with mock.patch.object(anki, "invoke", fake):
            decks.move_project("p", "Claude::V::A::One", "Claude::V::A::One renamed")
        self.assertEqual(fake.deleted, ["Claude::V::A::One"])
        self.assertIn("Claude::V::A", fake.cards)


if __name__ == "__main__":
    unittest.main()
