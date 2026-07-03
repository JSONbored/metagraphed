#!/usr/bin/env python3
"""Unit tests for backfill-stake-monthly.py's exact rao->TAO conversion (#2921).

Runnable both ways:

    python3 scripts/test_backfill_stake_monthly.py
    python3 -m pytest scripts/test_backfill_stake_monthly.py

Same to_tao_exact logic as fetch-metagraph-native.py (this script's own docstring
says "Units match scripts/fetch-metagraph-native.py exactly") — see
test_fetch_metagraph_native.py for the fuller test suite; this just confirms the
same fix landed correctly in this script's own copy of the helper.
"""
import importlib.util
import os
import unittest

_BSM_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "backfill-stake-monthly.py"
)
_spec = importlib.util.spec_from_file_location("backfill_stake_monthly_under_test", _BSM_PATH)
_bsm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bsm)

to_tao_exact = _bsm.to_tao_exact


class FakeBalance:
    def __init__(self, rao):
        self.rao = rao


class ToTaoExactTest(unittest.TestCase):
    def test_none_returns_none(self):
        self.assertIsNone(to_tao_exact(None))

    def test_small_value_matches_plain_division(self):
        self.assertEqual(to_tao_exact(FakeBalance(2_500_000_000)), 2.5)

    def test_large_validator_stake_whole_part_exact(self):
        rao = 50_000_000 * 10**9 + 123_456_789
        result = to_tao_exact(FakeBalance(rao))
        self.assertEqual(int(result), 50_000_000)

    def test_non_balance_value_falls_back_to_plain_float(self):
        self.assertEqual(to_tao_exact(3.5), 3.5)


if __name__ == "__main__":
    unittest.main()
