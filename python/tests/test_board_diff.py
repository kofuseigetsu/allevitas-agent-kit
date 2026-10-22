"""
Board diff helper unit tests (shared fixtures with the TypeScript SDK)
"""

import json
import os
import unittest

from allevitas import BoardDiffError, apply_board_operations, build_board_operations

FIXTURE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "testdata", "board_diff_cases.json"
)


class TestBuildBoardOperations(unittest.TestCase):
    def test_shared_fixture_cases(self):
        with open(FIXTURE_PATH, "r", encoding="utf-8") as f:
            cases = json.load(f)
        self.assertGreater(len(cases), 0)
        for case in cases:
            with self.subTest(case["name"]):
                ops = build_board_operations(case["old"], case["new"])
                self.assertEqual(ops, case["operations"])
                self.assertEqual(
                    apply_board_operations(case["old"], ops),
                    case["new"].replace("\r\n", "\n"),
                )

    def test_every_search_is_unique_at_apply_time(self):
        old = "- item\n- item\n- item\n"
        new = "- item\n- changed\n- item\n- added\n"
        ops = build_board_operations(old, new)
        self.assertTrue(all(op["search"] for op in ops))
        self.assertEqual(apply_board_operations(old, ops), new)

    def test_random_inputs_round_trip(self):
        import random

        rng = random.Random(42)
        words = ["a", "b", "", "a b", "$$", "日本"]
        for _ in range(500):
            def make() -> str:
                lines = [rng.choice(words) for _ in range(rng.randint(0, 10))]
                return "\n".join(lines) + rng.choice(["", "\n"])

            old, new = make(), make()
            ops = build_board_operations(old, new)
            self.assertEqual(apply_board_operations(old, ops), new)


class TestApplyBoardOperations(unittest.TestCase):
    def test_target_not_found(self):
        with self.assertRaises(BoardDiffError) as ctx:
            apply_board_operations("abc", [{"search": "x", "replace": "y"}])
        self.assertEqual(ctx.exception.code, "TARGET_NOT_FOUND")

    def test_ambiguous_target(self):
        with self.assertRaises(BoardDiffError) as ctx:
            apply_board_operations("a\na\n", [{"search": "a", "replace": "b"}])
        self.assertEqual(ctx.exception.code, "AMBIGUOUS_SEARCH_TARGET")

    def test_overlapping_matches_are_ambiguous(self):
        with self.assertRaises(BoardDiffError) as ctx:
            apply_board_operations("aaa", [{"search": "aa", "replace": "b"}])
        self.assertEqual(ctx.exception.code, "AMBIGUOUS_SEARCH_TARGET")

    def test_empty_search_on_non_empty_content(self):
        with self.assertRaises(BoardDiffError) as ctx:
            apply_board_operations("abc", [{"search": "", "replace": "x"}])
        self.assertEqual(ctx.exception.code, "INVALID_OPERATION")

    def test_replace_is_literal(self):
        result = apply_board_operations("cost: X", [{"search": "X", "replace": "$& $$ $' $`"}])
        self.assertEqual(result, "cost: $& $$ $' $`")

    def test_replace_all_and_initial_write(self):
        self.assertEqual(
            apply_board_operations("old", [{"search": "", "replace": "new", "type": "replace_all"}]),
            "new",
        )
        self.assertEqual(apply_board_operations("", [{"search": "", "replace": "first"}]), "first")


if __name__ == "__main__":
    unittest.main()
