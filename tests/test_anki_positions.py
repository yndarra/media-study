# -*- coding: utf-8 -*-
"""
Порядок карточек в Anki: позиция = порядок фрагментов; вставка в середину
сдвигает последующие (до первой свободной позиции), дублей нет, стоящие по
порядку карточки не трогаются. AnkiConnect подменён.
"""
import unittest
from unittest import mock

from phase3_export import anki


class FakeAnki:
    def __init__(self, ours: dict[int, int], others: dict[int, int] | None = None):
        # card_id == note_id для простоты; значение — позиция (due).
        self.due = dict(ours)
        self.others = dict(others or {})

    def __call__(self, action, **params):
        if action == "findCards":
            query = params["query"]
            if query.startswith("nid:"):
                ids = [int(x) for x in query.split()[0][4:].split(",")]
                return [i for i in ids if i in self.due]
            return list(self.others)
        if action == "cardsInfo":
            return [{"cardId": c, "note": c, "ord": 0, "due": self.due.get(c, self.others.get(c))} for c in params["cards"]]
        if action == "multi":
            for item in params["actions"]:
                card, value = item["params"]["card"], item["params"]["newValues"][0]
                (self.due if card in self.due else self.others)[card] = value
            return [None] * len(params["actions"])
        raise AssertionError(action)


def run(fake: FakeAnki, order: list[int]) -> int:
    with mock.patch.object(anki, "invoke", fake):
        return anki.resequence(order)


class TestResequence(unittest.TestCase):
    def test_already_in_order_untouched(self):
        fake = FakeAnki({1: 10, 2: 11, 3: 15, 4: 16})  # дыра 12-14 (изучаемые) — не уплотняется
        self.assertEqual(run(fake, [1, 2, 3, 4]), 0)

    def test_insert_in_middle_shifts_following_until_gap(self):
        # 9 — новая карточка (Anki поставил её в конец, 100), её место — между 2 и 3.
        fake = FakeAnki({1: 10, 2: 11, 3: 12, 4: 13, 5: 20, 9: 100})
        run(fake, [1, 2, 9, 3, 4, 5])
        self.assertEqual([fake.due[i] for i in (1, 2, 9, 3, 4, 5)], [10, 11, 12, 13, 14, 20])

    def test_two_new_in_a_row(self):
        fake = FakeAnki({1: 10, 2: 11, 3: 12, 8: 100, 9: 101})
        run(fake, [1, 8, 9, 2, 3])
        order = [fake.due[i] for i in (1, 8, 9, 2, 3)]
        self.assertEqual(order, sorted(order))
        self.assertEqual(len(set(order)), 5)
        self.assertLess(max(order), 100)  # хвост не улетел за новые

    def test_foreign_duplicate_is_moved_out(self):
        fake = FakeAnki({1: 10, 2: 11, 9: 100}, others={50: 12, 51: 13})
        run(fake, [1, 9, 2])
        ours = [fake.due[i] for i in (1, 9, 2)]
        self.assertEqual(ours, [10, 11, 12])
        self.assertTrue(all(v not in ours for v in fake.others.values()))
        self.assertLess(fake.others[50], fake.others[51])


if __name__ == "__main__":
    unittest.main()
