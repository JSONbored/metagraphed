#!/usr/bin/env python3
"""Unit tests for the indexer's PURE transforms (no chain/DB needed).

The live RPC/Postgres path is integration-verified against the bare-metal node +
Postgres (ADR 0013 gate); these lock the column mapping + cursor anchor so a
schema/decode change can't silently corrupt the write path. Run:
    python3 -m unittest scripts/test_index_chain.py
"""
import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "index_chain", os.path.join(_HERE, "index-chain.py")
)
ic = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ic)


def _decoded():
    """A decoded block in the stream-events.decode_head shape."""
    return {
        "block": {
            "block_number": 100,
            "block_hash": "0xabc",
            "parent_hash": "0xpar",
            "author": "5Author",
            "extrinsic_count": 3,
            "event_count": 7,
            "spec_version": 250,
            "observed_at": 1_700_000_000_000,
        },
        "extrinsics": [
            {
                "block_number": 100,
                "extrinsic_index": 2,
                "extrinsic_hash": "0xext",
                "signer": "5Signer",
                "call_module": "SubtensorModule",
                "call_function": "add_stake",
                "success": True,
                "fee_tao": 0.0001,
                "tip_tao": 0.0,
                "call_args": {"hotkey": "5HK", "amount": 1},
                "observed_at": 1_700_000_000_000,
            }
        ],
        "events": [
            {
                "block_number": 100,
                "event_index": 4,
                "extrinsic_index": 2,
                "event_kind": "StakeAdded",
                "hotkey": "5HK",
                "coldkey": "5CK",
                "netuid": 7,
                "uid": 12,
                "amount_tao": 1.5,
                "alpha_amount": 2.5,
                "observed_at": 1_700_000_000_000,
            }
        ],
    }


class RowsFromDecoded(unittest.TestCase):
    def test_block_row_maps_every_schema_column(self):
        rows = ic.rows_from_decoded(_decoded())
        self.assertEqual(len(rows["blocks"]), 1)
        b = rows["blocks"][0]
        self.assertEqual(set(b.keys()), set(ic.BLOCK_COLS))
        self.assertEqual(b["block_number"], 100)
        self.assertEqual(b["spec_version"], 250)
        self.assertEqual(b["observed_at"], 1_700_000_000_000)

    def test_extrinsic_row_maps_every_schema_column(self):
        x = ic.rows_from_decoded(_decoded())["extrinsics"][0]
        self.assertEqual(set(x.keys()), set(ic.EXTRINSIC_COLS))
        self.assertEqual(x["extrinsic_index"], 2)
        self.assertEqual(x["call_module"], "SubtensorModule")
        self.assertEqual(x["call_args"], {"hotkey": "5HK", "amount": 1})

    def test_event_row_remaps_amount_alpha_and_keeps_uid(self):
        e = ic.rows_from_decoded(_decoded())["account_events"][0]
        self.assertEqual(set(e.keys()), set(ic.EVENT_COLS))
        # decode_head emits amount_tao/alpha_amount; the schema columns are amount/alpha.
        self.assertEqual(e["amount"], 1.5)
        self.assertEqual(e["alpha"], 2.5)
        self.assertEqual(e["uid"], 12)
        self.assertEqual(e["extrinsic_index"], 2)
        self.assertNotIn("amount_tao", e)

    def test_no_block_yields_empty_blocks(self):
        d = _decoded()
        d["block"] = None
        rows = ic.rows_from_decoded(d)
        self.assertEqual(rows["blocks"], [])
        self.assertEqual(len(rows["account_events"]), 1)

    def test_empty_inputs_are_safe(self):
        rows = ic.rows_from_decoded({"block": None, "extrinsics": [], "events": []})
        self.assertEqual(rows, {"blocks": [], "extrinsics": [], "account_events": []})
        rows2 = ic.rows_from_decoded({})  # missing keys
        self.assertEqual(rows2, {"blocks": [], "extrinsics": [], "account_events": []})


class BackfillStart(unittest.TestCase):
    def test_cold_cursor_with_start_block_anchors_there(self):
        # cursor=None + START_BLOCK set short-circuits before any chain/module load.
        self.assertEqual(ic.backfill_start(None, 9999, "5000"), 5000)
        self.assertEqual(ic.backfill_start(None, 9999, "0"), 0)


if __name__ == "__main__":
    unittest.main()
