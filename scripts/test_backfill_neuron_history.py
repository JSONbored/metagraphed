#!/usr/bin/env python3
"""Unit tests for backfill-neuron-history.py's exact rao->TAO conversion (#2921).

Runnable both ways:

    python3 scripts/test_backfill_neuron_history.py
    python3 -m pytest scripts/test_backfill_neuron_history.py
"""
import importlib.util
import os
import sys
import types
import unittest

# backfill-neuron-history.py imports bittensor and xxhash at module level (used
# by main()/twox128, unrelated to the pure conversion logic under test here) --
# stub both so this module can be loaded for testing without the heavy/native
# deps installed, without changing the script's own import structure.
for _mod_name in ("bittensor", "xxhash"):
    if _mod_name not in sys.modules:
        sys.modules[_mod_name] = types.ModuleType(_mod_name)

_BNH_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "backfill-neuron-history.py"
)
_spec = importlib.util.spec_from_file_location("backfill_neuron_history_under_test", _BNH_PATH)
_bnh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bnh)

rao_to_tao_exact = _bnh.rao_to_tao_exact


class RaoToTaoExactTest(unittest.TestCase):
    def test_none_returns_none(self):
        self.assertIsNone(rao_to_tao_exact(None))

    def test_zero(self):
        self.assertEqual(rao_to_tao_exact(0), 0)

    def test_small_value_matches_plain_division(self):
        self.assertEqual(rao_to_tao_exact(2_500_000_000), 2.5)

    def test_large_emission_whole_part_exact(self):
        # An intentionally large emission value (real per-UID emission is
        # small, but the conversion must be correct at any magnitude).
        rao = 50_000_000 * 10**9 + 123_456_789
        result = rao_to_tao_exact(rao)
        self.assertEqual(int(result), 50_000_000)

    def test_extreme_magnitude_whole_part_exact(self):
        rao = 9_007_199_254_740_993_123
        result = rao_to_tao_exact(rao)
        self.assertEqual(int(result), rao // 1_000_000_000)


if __name__ == "__main__":
    unittest.main()
