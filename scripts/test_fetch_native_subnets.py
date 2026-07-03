#!/usr/bin/env python3
"""Unit tests for fetch-native-subnets.py's exact rao->TAO conversion and
sum-in-rao-space aggregation (#2921).

Runnable both ways:

    python3 scripts/test_fetch_native_subnets.py
    python3 -m pytest scripts/test_fetch_native_subnets.py
"""
import importlib.util
import os
import types
import unittest

_FNS_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fetch-native-subnets.py"
)
_spec = importlib.util.spec_from_file_location("fetch_native_subnets_under_test", _FNS_PATH)
_fns = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fns)

to_rao_exact = _fns.to_rao_exact
rao_to_tao_exact = _fns.rao_to_tao_exact
to_tao_exact = _fns.to_tao_exact
normalize_economics = _fns.normalize_economics


class FakeBalance:
    def __init__(self, rao):
        self.rao = rao


class ConversionHelpersTest(unittest.TestCase):
    def test_to_rao_exact_reads_balance_rao_directly(self):
        self.assertEqual(to_rao_exact(FakeBalance(123_456_789_000)), 123_456_789_000)

    def test_to_rao_exact_none(self):
        self.assertIsNone(to_rao_exact(None))

    def test_rao_to_tao_exact_matches_plain_division_for_small_values(self):
        self.assertEqual(rao_to_tao_exact(2_500_000_000), 2.5)

    def test_to_tao_exact_composes_both(self):
        self.assertEqual(to_tao_exact(FakeBalance(2_500_000_000)), 2.5)
        self.assertIsNone(to_tao_exact(None))


class NormalizeEconomicsAggregationTest(unittest.TestCase):
    def test_total_stake_sums_in_rao_space_not_float_space(self):
        # Three large per-UID stakes, each individually above the point where
        # summing pre-converted floats would compound rounding error. The old
        # code did `round(sum(to_tao(entry) for entry in total_stake), 9)` --
        # summing TAO floats. The fix sums rao ints first, converts once.
        stakes = [
            FakeBalance(3_707_767 * 10**9 + 110_483_468),
            FakeBalance(3_560_214 * 10**9 + 214_195_670),
            FakeBalance(3_323_419 * 10**9 + 873_737_862),
        ]
        info = types.SimpleNamespace(
            validator_permit=[True, True, True],
            num_uids=3,
            max_uids=256,
            max_validators=64,
            registration_allowed=True,
            burn=FakeBalance(1_000_000_000),
            moving_price=FakeBalance(500_000_000),
            total_stake=stakes,
            tao_in=FakeBalance(10_000_000_000),
            alpha_in=FakeBalance(10_000_000_000),
            alpha_out=FakeBalance(10_000_000_000),
            subnet_volume=FakeBalance(1_000_000_000),
            owner_hotkey="",
            owner_coldkey="",
        )
        result = normalize_economics(info)
        expected_total_rao = sum(s.rao for s in stakes)
        expected_whole_tao = expected_total_rao // 1_000_000_000
        self.assertEqual(int(result["total_stake_tao"]), expected_whole_tao)
        self.assertEqual(result["max_stake_tao"], rao_to_tao_exact(max(s.rao for s in stakes)))

    def test_empty_stakes_returns_none(self):
        info = types.SimpleNamespace(
            validator_permit=[],
            num_uids=0,
            max_uids=0,
            max_validators=0,
            registration_allowed=False,
            burn=None,
            moving_price=None,
            total_stake=[],
            tao_in=None,
            alpha_in=None,
            alpha_out=None,
            subnet_volume=None,
            owner_hotkey="",
            owner_coldkey="",
        )
        result = normalize_economics(info)
        self.assertIsNone(result["total_stake_tao"])
        self.assertIsNone(result["max_stake_tao"])


if __name__ == "__main__":
    unittest.main()
