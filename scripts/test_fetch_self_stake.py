#!/usr/bin/env python3
"""Unit tests for fetch-self-stake.py's pure share-fraction math (#6507).

Runnable both ways:

    python3 scripts/test_fetch_self_stake.py
    python3 -m pytest scripts/test_fetch_self_stake.py

Loaded by path (hyphenated filename), same convention as
test_fetch_metagraph_native.py. Does not import the real `bittensor`
package -- _exact_ratio is pure arithmetic, no SDK objects involved.
"""
import importlib.util
import os
import unittest

_FSS_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fetch-self-stake.py"
)
_spec = importlib.util.spec_from_file_location("fetch_self_stake_under_test", _FSS_PATH)
_fss = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fss)

_exact_ratio = _fss._exact_ratio


class ExactRatioTest(unittest.TestCase):
    def test_zero_denominator_returns_zero_not_a_crash(self):
        self.assertEqual(_exact_ratio(100, 0), 0.0)

    def test_negative_denominator_returns_zero(self):
        # Never observed live, but a negative TotalHotkeyAlpha read would be
        # nonsensical -- treat it the same as zero rather than dividing.
        self.assertEqual(_exact_ratio(100, -5), 0.0)

    def test_full_ownership_yields_fraction_one(self):
        # The exact numbers seen live 2026-07-17: TotalHotkeyAlpha=1861288182,
        # get_stake().rao=1861288182 -- an owner holding 100% of a hotkey's
        # alpha with zero explicit third-party nominators.
        self.assertEqual(_exact_ratio(1_861_288_182, 1_861_288_182), 1.0)

    def test_partial_ownership_yields_proportional_fraction(self):
        self.assertAlmostEqual(_exact_ratio(25, 100), 0.25)

    def test_ratio_can_exceed_one_before_the_caller_clamps(self):
        # _exact_ratio itself does no clamping -- that's main()'s job (chain
        # state can move between the two non-atomic RPC reads). Confirms the
        # helper doesn't silently cap this itself, which would hide the
        # caller's own clamp being exercised in a real run.
        self.assertEqual(_exact_ratio(150, 100), 1.5)


if __name__ == "__main__":
    unittest.main()
