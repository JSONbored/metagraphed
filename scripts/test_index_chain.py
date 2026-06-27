#!/usr/bin/env python3
"""Unit tests for the indexer's PURE transforms (no chain/DB needed).

The live RPC/Postgres path is integration-verified against the bare-metal node +
Postgres (ADR 0013 gate); these lock the column mapping + cursor anchor so a
schema/decode change can't silently corrupt the write path. Run:
    python3 -m unittest scripts/test_index_chain.py
"""
import importlib.util
import os
import signal
import types
import unittest
from unittest import mock

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
                # _extrinsic_success_map emits 1/0 (int), NOT a bool — the shape
                # the indexer must coerce for the Postgres BOOLEAN column.
                "success": 1,
                "fee_tao": 0.0001,
                "tip_tao": 0.0,
                # The verified decode (_safe_json) emits call_args as a compact
                # JSON STRING, not a dict — the shape the indexer must handle.
                "call_args": '{"hotkey":"5HK","amount":1}',
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

    def test_success_int_is_coerced_to_bool_for_postgres(self):
        # Regression: _extrinsic_success_map emits 1/0 (int); the Postgres column
        # is BOOLEAN (strict), so 1 -> True, 0 -> False, missing -> None.
        x = ic.rows_from_decoded(_decoded())["extrinsics"][0]
        self.assertIs(x["success"], True)
        d = _decoded()
        d["extrinsics"][0]["success"] = 0
        self.assertIs(ic.rows_from_decoded(d)["extrinsics"][0]["success"], False)
        d["extrinsics"][0]["success"] = None
        self.assertIsNone(ic.rows_from_decoded(d)["extrinsics"][0]["success"])

    def test_call_args_json_string_is_decoded_to_an_object(self):
        # Regression: the decode emits call_args as a JSON STRING; it must be
        # parsed to an object so the single Json() wrap stores a JSONB object,
        # not a double-encoded scalar string.
        x = ic.rows_from_decoded(_decoded())["extrinsics"][0]
        self.assertIsInstance(x["call_args"], dict)
        self.assertEqual(x["call_args"], {"hotkey": "5HK", "amount": 1})
        # Unparseable call_args degrades to None (never a raw string into JSONB).
        d = _decoded()
        d["extrinsics"][0]["call_args"] = "{not valid json"
        self.assertIsNone(ic.rows_from_decoded(d)["extrinsics"][0]["call_args"])

    def test_rows_without_observed_at_are_dropped(self):
        # observed_at is NOT NULL; a None (Timestamp miss) must be dropped, not
        # sent to INSERT (which would IntegrityError + wedge the indexer).
        d = _decoded()
        d["block"]["observed_at"] = None
        d["extrinsics"][0]["observed_at"] = None
        d["events"][0]["observed_at"] = None
        rows = ic.rows_from_decoded(d)
        self.assertEqual(rows["blocks"], [])
        self.assertEqual(rows["extrinsics"], [])
        self.assertEqual(rows["account_events"], [])

    def test_event_row_preserves_serving_amount_columns_and_keeps_uid(self):
        e = ic.rows_from_decoded(_decoded())["account_events"][0]
        self.assertEqual(set(e.keys()), set(ic.EVENT_COLS))
        # Keep the D1-era serving names so Worker readers need only a binding swap.
        self.assertEqual(e["amount_tao"], 1.5)
        self.assertEqual(e["alpha_amount"], 2.5)
        self.assertEqual(e["uid"], 12)
        self.assertEqual(e["extrinsic_index"], 2)
        self.assertNotIn("amount", e)

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


class DecodeHeadImport(unittest.TestCase):
    def test_decode_head_preserves_indexer_signal_handlers(self):
        previous_term = signal.getsignal(signal.SIGTERM)
        previous_int = signal.getsignal(signal.SIGINT)

        def stream_events_signal_handler(_signum, _frame):
            return None

        def decode_head(_s, _block_number):
            return {}

        def import_stream_events(_modname, _filename):
            signal.signal(signal.SIGTERM, stream_events_signal_handler)
            signal.signal(signal.SIGINT, stream_events_signal_handler)
            return types.SimpleNamespace(decode_head=decode_head)

        try:
            signal.signal(signal.SIGTERM, ic._handle_signal)
            signal.signal(signal.SIGINT, ic._handle_signal)

            with mock.patch.object(ic, "_load", side_effect=import_stream_events):
                self.assertIs(ic._decode_head(), decode_head)

            self.assertIs(signal.getsignal(signal.SIGTERM), ic._handle_signal)
            self.assertIs(signal.getsignal(signal.SIGINT), ic._handle_signal)
        finally:
            signal.signal(signal.SIGTERM, previous_term)
            signal.signal(signal.SIGINT, previous_int)


class PostgresSchemaContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = os.path.dirname(_HERE)
        with open(
            os.path.join(root, "deploy", "postgres", "schema.sql"), encoding="utf-8"
        ) as schema_file:
            cls.schema = schema_file.read()

    def test_account_events_schema_uses_serving_columns(self):
        for column in ("uid", "amount_tao", "alpha_amount", "extrinsic_index"):
            self.assertIn(column, self.schema)
        self.assertNotIn("  amount           NUMERIC", self.schema)
        self.assertNotIn("  alpha            NUMERIC", self.schema)

    def test_metagraph_schema_uses_serving_columns(self):
        for column in (
            "validator_trust",
            "emission_tao",
            "registered_at_block",
            "is_immunity_period",
            "block_number",
            "captured_at",
        ):
            self.assertIn(column, self.schema)
        self.assertNotIn("  emission         NUMERIC", self.schema)

    def test_account_events_daily_schema_uses_history_columns(self):
        for column in (
            "netuid",
            "event_kinds",
            "first_block",
            "last_block",
            "updated_at",
        ):
            self.assertIn(column, self.schema)

    def test_indexer_cursor_schema_allows_live_and_backfill_cursors(self):
        self.assertIn("CHECK (id IN (1, 2))", self.schema)
        self.assertIn("DROP CONSTRAINT IF EXISTS indexer_cursor_singleton", self.schema)
        self.assertNotIn("CHECK (id = 1)", self.schema)


class BackfillStart(unittest.TestCase):
    def test_cold_cursor_with_start_block_anchors_there(self):
        # cursor=None + START_BLOCK set short-circuits before any chain/module load.
        self.assertEqual(ic.backfill_start(None, 9999, "5000"), 5000)
        self.assertEqual(ic.backfill_start(None, 9999, "0"), 0)


if __name__ == "__main__":
    unittest.main()
