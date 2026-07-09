#!/usr/bin/env python3
"""Unit tests for fetch-subnet-hyperparams.py's pure conversion helpers (#4304/1.1
field-mapping spike, #4305/1.2 implementation).

Runnable both ways:

    python3 scripts/test_fetch_subnet_hyperparams.py
    python3 -m pytest scripts/test_fetch_subnet_hyperparams.py

Loaded by path (hyphenated filename), same convention as
test_fetch_metagraph_native.py. Does not import the real `bittensor` package —
main-path tests inject a tiny fake SDK module.
"""
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

_FSH_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fetch-subnet-hyperparams.py"
)
_spec = importlib.util.spec_from_file_location(
    "fetch_subnet_hyperparams_under_test", _FSH_PATH
)
_fsh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fsh)

u16_ratio = _fsh.u16_ratio
rao_to_tao_exact = _fsh.rao_to_tao_exact
to_flag = _fsh.to_flag
to_float = _fsh.to_float


class _Info:
    def __init__(self, netuid, mechid=0):
        self.netuid = netuid
        self.mechid = mechid


class _Hp:
    tempo = 360


class FetchCompletenessTest(unittest.TestCase):
    def run_main(self, responses, infos=None):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "hyperparams.json")

            class _SubtensorApi:
                def __init__(self, network):
                    self.network = network
                    self.substrate = types.SimpleNamespace(block_number=123)
                    discovered_infos = (
                        [_Info(1), _Info(2), _Info(99, mechid=1)]
                        if infos is None
                        else infos
                    )
                    self.metagraphs = types.SimpleNamespace(
                        get_all_metagraphs_info=lambda all_mechanisms: discovered_infos
                    )

                    def get_subnet_hyperparameters(netuid):
                        value = responses[netuid]
                        if isinstance(value, Exception):
                            raise value
                        return value

                    self.subnets = types.SimpleNamespace(
                        get_subnet_hyperparameters=get_subnet_hyperparameters
                    )

            fake_bt = types.SimpleNamespace(SubtensorApi=_SubtensorApi)
            with mock.patch.object(_fsh, "OUT", out):
                with mock.patch.dict(sys.modules, {"bittensor": fake_bt}):
                    with mock.patch.object(sys, "argv", ["fetch-subnet-hyperparams.py"]):
                        with self.assertRaises(SystemExit) as cm:
                            _fsh.main()
            with open(out) as fh:
                rows = json.load(fh)
            return cm.exception.code, rows

    def test_per_netuid_exception_fails_instead_of_signing_partial_snapshot(self):
        code, rows = self.run_main({1: _Hp(), 2: RuntimeError("rpc failed")})
        self.assertEqual(code, 1)
        self.assertEqual([row["netuid"] for row in rows], [1])

    def test_empty_hyperparameters_response_fails_instead_of_signing_partial_snapshot(self):
        code, rows = self.run_main({1: _Hp(), 2: None})
        self.assertEqual(code, 1)
        self.assertEqual([row["netuid"] for row in rows], [1])

    def test_empty_active_netuid_discovery_fails_instead_of_signing_empty_snapshot(self):
        code, rows = self.run_main({}, infos=[])
        self.assertEqual(code, 1)
        self.assertEqual(rows, [])


class U16RatioTest(unittest.TestCase):
    def test_none_returns_none(self):
        self.assertIsNone(u16_ratio(None))

    def test_zero_is_zero(self):
        self.assertEqual(u16_ratio(0), 0.0)

    def test_max_u16_is_one(self):
        self.assertEqual(u16_ratio(65535), 1.0)

    def test_midpoint_matches_expected_ratio(self):
        # Live-probed kappa value (research spike, #4304): 32767 / 65535.
        self.assertAlmostEqual(u16_ratio(32767), 0.499992, places=6)

    def test_string_typed_value_coerces(self):
        self.assertEqual(u16_ratio("65535"), 1.0)

    def test_non_numeric_returns_none(self):
        self.assertIsNone(u16_ratio("not-a-number"))


class RaoToTaoExactTest(unittest.TestCase):
    def test_none_returns_none(self):
        self.assertIsNone(rao_to_tao_exact(None))

    def test_small_value_matches_plain_division(self):
        rao = 500_000_000  # 0.5 TAO — a live-probed min_burn value (research spike)
        self.assertEqual(rao_to_tao_exact(rao), 0.5)

    def test_extreme_magnitude_matches_exact_integer_math(self):
        # Mirrors to_tao_exact's equivalent test in test_fetch_metagraph_native.py
        # — the whole-TAO part must always match exact integer division, unlike
        # float(rao)/1e9 which routes the whole integer through double rounding.
        rao = 9_007_199_254_740_993_123
        result = rao_to_tao_exact(rao)
        whole_tao = rao // 1_000_000_000
        self.assertEqual(int(result), whole_tao)

    def test_non_numeric_returns_none(self):
        self.assertIsNone(rao_to_tao_exact("not-a-number"))


class ToFlagTest(unittest.TestCase):
    def test_true_is_one(self):
        self.assertEqual(to_flag(True), 1)

    def test_false_is_zero(self):
        self.assertEqual(to_flag(False), 0)

    def test_none_is_zero(self):
        self.assertEqual(to_flag(None), 0)


class ToFloatTest(unittest.TestCase):
    def test_none_returns_none(self):
        self.assertIsNone(to_float(None))

    def test_valid_value_converts(self):
        self.assertEqual(to_float("1.26"), 1.26)

    def test_non_numeric_returns_none(self):
        self.assertIsNone(to_float("not-a-number"))


if __name__ == "__main__":
    unittest.main()
