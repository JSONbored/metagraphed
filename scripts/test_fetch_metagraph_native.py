#!/usr/bin/env python3
"""Unit tests for fetch-metagraph-native.py's exact rao->TAO conversion (#2921).

Runnable both ways:

    python3 scripts/test_fetch_metagraph_native.py
    python3 -m pytest scripts/test_fetch_metagraph_native.py

Loaded by path (hyphenated filename) the same way test_fetch_events.py loads
fetch-events.py. Does not import the real `bittensor` package — to_tao_exact
only needs a `.rao` attribute (duck-typed), so a minimal stand-in is enough to
exercise the pure conversion logic without the heavy SDK dependency.
"""
import importlib.util
import os
import unittest

_FMN_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fetch-metagraph-native.py"
)
_spec = importlib.util.spec_from_file_location("fetch_metagraph_native_under_test", _FMN_PATH)
_fmn = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fmn)

to_tao_exact = _fmn.to_tao_exact
to_float = _fmn.to_float


class FakeBalance:
    """Duck-types the one attribute to_tao_exact reads from a real Balance."""

    def __init__(self, rao):
        self.rao = rao


class ToTaoExactTest(unittest.TestCase):
    def test_none_returns_none(self):
        self.assertIsNone(to_tao_exact(None))

    def test_small_value_matches_plain_division(self):
        # Well under 2**53 rao -- exact and float division should agree exactly.
        rao = 2_500_000_000  # 2.5 TAO
        self.assertEqual(to_tao_exact(FakeBalance(rao)), 2.5)

    def test_extreme_magnitude_matches_exact_integer_math(self):
        # An intentionally extreme rao value (~9.007 billion TAO). The whole-TAO
        # part must always match exact integer division -- this is the actual
        # guarantee the fix provides (unlike float(rao)/1e9, which routes the
        # whole integer through double rounding before dividing at all).
        rao = 9_007_199_254_740_993_123
        result = to_tao_exact(FakeBalance(rao))
        whole_tao = rao // 1_000_000_000
        self.assertEqual(int(result), whole_tao)

    def test_realistic_large_validator_stake(self):
        # 50M TAO -- above the ~9.007M ceiling, a plausible "what if a large
        # validator/foundation wallet grows" magnitude, unlike the extreme
        # test above. The whole-TAO part must be exact.
        rao = 50_000_000 * 10**9 + 123_456_789
        result = to_tao_exact(FakeBalance(rao))
        self.assertEqual(int(result), 50_000_000)
        # Sub-TAO accuracy is bounded by double precision at this magnitude
        # (~7-8 significant fractional digits, not the full 9 rao decimals).
        self.assertAlmostEqual(result - 50_000_000, 0.123456789, places=7)

    def test_non_balance_value_falls_back_to_plain_float(self):
        # Defensive path: something without .rao (e.g. an already-plain number)
        # falls back to to_float rather than raising.
        self.assertEqual(to_tao_exact(3.5), 3.5)


if __name__ == "__main__":
    unittest.main()
