#!/usr/bin/env python3
"""Unit tests for the chain-event poller's cursor/window logic (#1346 audit fix).

The poll workflow has no Python test runner, so these are stdlib `unittest` only
(zero deps) and are runnable BOTH ways:

    python3 scripts/test_fetch_events.py          # standalone (CI-friendly)
    python3 -m unittest scripts.test_fetch_events  # via the unittest runner
    python3 -m pytest scripts/test_fetch_events.py # if pytest is available

fetch-events.py is hyphenated, so we load it by path the same way stream-events.py
imports it (importlib) — no package rename needed. We only exercise the PURE
functions (compute_from_block, _parse_cursor); nothing here touches the network.
"""
import importlib.util
import os
import unittest

_FE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fetch-events.py"
)
_spec = importlib.util.spec_from_file_location("fetch_events_under_test", _FE_PATH)
_fe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fe)

compute_from_block = _fe.compute_from_block
_parse_cursor = _fe._parse_cursor


class ComputeFromBlockTest(unittest.TestCase):
    WINDOW = 250
    HEAD = 10_000

    def floor(self, head=None, window=None):
        head = self.HEAD if head is None else head
        window = self.WINDOW if window is None else window
        return max(0, head - window + 1)

    def test_cold_cursor_uses_window_floor(self):
        # cursor None → exactly head - window + 1 (the fixed look-back floor).
        self.assertEqual(
            compute_from_block(None, self.HEAD, self.WINDOW), self.floor()
        )

    def test_fresh_cursor_still_uses_window_floor(self):
        # A cursor just behind the head only proves the range was staged to R2,
        # not that the asynchronous Worker imported it into D1. Keep re-scanning
        # the overlap floor so an overwritten pending batch can be recreated.
        cursor = self.HEAD - 10
        self.assertEqual(
            compute_from_block(cursor, self.HEAD, self.WINDOW), self.floor()
        )
        self.assertLess(self.floor(), cursor + 1)

    def test_stale_cursor_older_than_window_is_capped_at_floor(self):
        # A cursor far older than the window must NOT trigger a whole-chain rescan;
        # the floor wins, bounding the scan to `window` blocks.
        stale = self.HEAD - 5_000  # gap (5000) >> window (250)
        got = compute_from_block(stale, self.HEAD, self.WINDOW)
        self.assertEqual(got, self.floor())
        # And the scan span never exceeds `window` blocks.
        self.assertLessEqual(self.HEAD - got + 1, self.WINDOW)
        # Importantly we did NOT resume from the ancient cursor+1.
        self.assertNotEqual(got, stale + 1)

    def test_cursor_ahead_of_head_reorg_uses_floor(self):
        # Reorg / clock skew left the cursor at or past the head → re-scan the
        # overlap window (idempotent) rather than an empty or negative range.
        self.assertEqual(
            compute_from_block(self.HEAD + 50, self.HEAD, self.WINDOW), self.floor()
        )

    def test_cursor_equal_to_head_uses_floor(self):
        # Boundary: cursor == head means "nothing new"; re-scan the window.
        self.assertEqual(
            compute_from_block(self.HEAD, self.HEAD, self.WINDOW), self.floor()
        )

    def test_cursor_exactly_one_behind_still_uses_floor(self):
        # Boundary: cursor == head - 1 still re-scans the overlap window.
        self.assertEqual(
            compute_from_block(self.HEAD - 1, self.HEAD, self.WINDOW), self.floor()
        )

    def test_cursor_at_window_boundary_prefers_cursor(self):
        # cursor + 1 exactly equals the floor → both agree (no off-by-one gap).
        cursor = self.floor() - 1
        self.assertEqual(
            compute_from_block(cursor, self.HEAD, self.WINDOW), self.floor()
        )

    def test_never_negative_near_genesis(self):
        # Window larger than the head must clamp the floor to 0, never go negative.
        self.assertEqual(compute_from_block(None, 5, 250), 0)
        # With a low cursor near genesis we still use the overlap floor because
        # staging is not proof of D1 persistence.
        self.assertEqual(compute_from_block(2, 5, 250), 0)
        self.assertGreaterEqual(compute_from_block(2, 5, 250), 0)
        # A None cursor with head 0 and any window clamps to 0 (not -249).
        self.assertEqual(compute_from_block(None, 0, 250), 0)


class ParseCursorTest(unittest.TestCase):
    def test_none_and_blank_are_cold(self):
        self.assertIsNone(_parse_cursor(None))
        self.assertIsNone(_parse_cursor(""))
        self.assertIsNone(_parse_cursor("   "))

    def test_numeric_string_parses(self):
        self.assertEqual(_parse_cursor("12345"), 12345)
        self.assertEqual(_parse_cursor(" 42 "), 42)
        self.assertEqual(_parse_cursor(0), 0)

    def test_garbage_is_cold(self):
        self.assertIsNone(_parse_cursor("abc"))
        self.assertIsNone(_parse_cursor("12.5"))
        self.assertIsNone(_parse_cursor("<cold start>"))

    def test_negative_is_cold(self):
        self.assertIsNone(_parse_cursor("-1"))
        self.assertIsNone(_parse_cursor(-7))


if __name__ == "__main__":
    unittest.main(verbosity=2)
