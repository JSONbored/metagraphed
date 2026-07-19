#!/usr/bin/env python3
"""Unit tests for fetch-account-balances.py's pure rao->TAO conversion
(#6742).

Runnable both ways:

    python3 scripts/test_fetch_account_balances.py
    python3 -m pytest scripts/test_fetch_account_balances.py

Loaded by path (hyphenated filename), same convention as
test_fetch_self_stake.py. Does not import the real `bittensor` package --
rao_to_tao_exact is pure arithmetic, no SDK objects involved.
"""
import importlib.util
import os
import unittest

_FAB_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fetch-account-balances.py"
)
_spec = importlib.util.spec_from_file_location("fetch_account_balances_under_test", _FAB_PATH)
_fab = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fab)

rao_to_tao_exact = _fab.rao_to_tao_exact


class RaoToTaoExactTest(unittest.TestCase):
    def test_none_returns_none(self):
        self.assertIsNone(rao_to_tao_exact(None))

    def test_zero(self):
        self.assertEqual(rao_to_tao_exact(0), 0)

    def test_small_value_matches_plain_division(self):
        self.assertEqual(rao_to_tao_exact(2_500_000_000), 2.5)

    def test_non_numeric_returns_none(self):
        self.assertIsNone(rao_to_tao_exact("not-a-number"))

    def test_exact_above_2_53_rao_where_naive_float_division_loses_precision(self):
        # 10,000,000 TAO in rao -- comfortably above 2**53 rao (~9M TAO),
        # where a naive float(rao) / 1e9 starts losing low-order digits.
        rao = 10_000_000_123_456_789
        result = rao_to_tao_exact(rao)
        naive = float(rao) / 1e9
        self.assertNotEqual(result, naive)
        self.assertAlmostEqual(result, 10_000_000.123456789, places=6)

    def test_accepts_a_string_int_too(self):
        # query_map's decoded values are sometimes stringified ints
        # depending on the substrate-interface type registry's own
        # representation -- confirm the int(rao) coercion handles that.
        self.assertEqual(rao_to_tao_exact("2500000000"), 2.5)


if __name__ == "__main__":
    unittest.main()
