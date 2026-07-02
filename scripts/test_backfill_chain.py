#!/usr/bin/env python3
"""Unit tests for the backfill job's PURE range logic (no chain/DB needed)."""
import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "backfill_chain", os.path.join(_HERE, "backfill-chain.py")
)
bf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bf)


class BackfillRange(unittest.TestCase):
    def test_depth_days_default_window(self):
        frm, to = bf.backfill_range(8_500_000, 365, None, None)
        self.assertEqual(to, 8_500_000)
        self.assertEqual(frm, 8_500_000 - 365 * bf.BLOCKS_PER_DAY)

    def test_explicit_from_to_override_wins(self):
        self.assertEqual(bf.backfill_range(8_500_000, 365, "100", "200"), (100, 200))

    def test_window_clamped_to_zero(self):
        # depth window deeper than the head must not go negative.
        frm, to = bf.backfill_range(1000, 365, None, None)
        self.assertEqual((frm, to), (0, 1000))

    def test_partial_from_override_keeps_head_as_to(self):
        frm, to = bf.backfill_range(8_500_000, 365, "7000000", None)
        self.assertEqual((frm, to), (7_000_000, 8_500_000))


class Flush(unittest.TestCase):
    def test_flush_upserts_every_decoded_tier_incl_chain_events(self):
        # Regression: _flush must upsert every tier rows_from_decoded produces. The
        # live indexer upserts chain_events (index-chain.py) and the module docstring
        # promises "zero decode/schema drift", so a backfilled range must fill the
        # generic all-events tier too — otherwise deep-history /api/v1/chain-events
        # reads are silently empty for backfilled blocks.
        calls = []
        original = bf.ic._upsert
        bf.ic._upsert = lambda conn, table, cols, rows, conflict: calls.append(table)
        try:
            bf._flush(
                object(),
                [
                    {
                        "blocks": [{"block_number": 1}],
                        "extrinsics": [],
                        "account_events": [],
                        "chain_events": [{"block_number": 1, "event_index": 0}],
                    }
                ],
            )
        finally:
            bf.ic._upsert = original
        self.assertEqual(
            calls, ["blocks", "extrinsics", "account_events", "chain_events"]
        )


if __name__ == "__main__":
    unittest.main()
