#!/usr/bin/env python3
"""Unit tests for the chain-event poller's cursor/window logic (#1346 audit fix).

The poll workflow has no Python test runner, so these are stdlib `unittest` only
(zero deps) and are runnable BOTH ways:

    python3 scripts/test_fetch_events.py          # standalone (CI-friendly)
    python3 -m unittest scripts.test_fetch_events  # via the unittest runner
    python3 -m pytest scripts/test_fetch_events.py # if pytest is available

fetch-events.py is hyphenated, so we load it by path the same way stream-events.py
imports it (importlib) — no package rename needed. We only exercise the PURE
functions (compute_from_block, _parse_cursor); nothing here touches the network.
"""
import importlib.util
import os
import unittest

_FE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fetch-events.py"
)
_spec = importlib.util.spec_from_file_location("fetch_events_under_test", _FE_PATH)
_fe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fe)

compute_from_block = _fe.compute_from_block
compute_scan_range = _fe.compute_scan_range
_parse_cursor = _fe._parse_cursor
_block_author = _fe._block_author
AURA_ENGINE_ID = _fe.AURA_ENGINE_ID
PRUNE_HORIZON = _fe.PRUNE_HORIZON


class ComputeFromBlockTest(unittest.TestCase):
    WINDOW = 250
    HEAD = 10_000

    def floor(self, head=None, window=None):
        head = self.HEAD if head is None else head
        window = self.WINDOW if window is None else window
        return max(0, head - window + 1)

    def test_cold_cursor_uses_window_floor(self):
        # cursor None → exactly head - window + 1 (the fixed look-back floor).
        self.assertEqual(
            compute_from_block(None, self.HEAD, self.WINDOW), self.floor()
        )

    def test_fresh_cursor_still_uses_window_floor(self):
        # A cursor just behind the head only proves the range was staged to R2,
        # not that the asynchronous Worker imported it into D1. Keep re-scanning
        # the overlap floor so an overwritten pending batch can be recreated.
        cursor = self.HEAD - 10
        self.assertEqual(
            compute_from_block(cursor, self.HEAD, self.WINDOW), self.floor()
        )
        self.assertLess(self.floor(), cursor + 1)

    def test_stale_cursor_recovers_back_to_the_lookback_bound(self):
        # A cursor far older than the lookback bound: recover the gap, but only as
        # far back as `head - max_lookback` (default = prune horizon — no point
        # reaching past the public-RPC prune wall). NOT capped at the window floor
        # (we DO recover beyond the overlap), and NOT the ancient cursor + 1.
        stale = self.HEAD - 5_000  # gap (5000) >> lookback (PRUNE_HORIZON)
        got = compute_from_block(stale, self.HEAD, self.WINDOW)
        self.assertEqual(got, self.HEAD - PRUNE_HORIZON)
        self.assertLess(got, self.floor())  # recovered earlier than the overlap
        self.assertNotEqual(got, stale + 1)  # but bounded — not the ancient cursor

    def test_archive_lookback_recovers_the_full_gap(self):
        # Against an archive (no prune wall), a high max_lookback recovers the WHOLE
        # coalescing gap: the scan resumes from cursor + 1.
        stale = self.HEAD - 5_000
        got = compute_from_block(stale, self.HEAD, self.WINDOW, 10_000_000)
        self.assertEqual(got, stale + 1)

    def test_gap_within_lookback_resumes_from_cursor(self):
        # A gap wider than the window but inside the lookback bound is fully
        # recovered from cursor + 1 — not just the overlap floor.
        cursor = self.HEAD - (PRUNE_HORIZON - 20)
        got = compute_from_block(cursor, self.HEAD, self.WINDOW)
        self.assertEqual(got, cursor + 1)
        self.assertLess(got, self.floor())

    def test_scan_range_caps_long_archive_recovery_to_bounded_batch(self):
        stale = self.HEAD - 5_000
        start, end = compute_scan_range(stale, self.HEAD, self.WINDOW, 10_000_000)
        self.assertEqual(start, stale + 1)
        self.assertEqual(end, start + self.WINDOW - 1)
        self.assertLess(end, self.HEAD)

    def test_scan_range_promotes_to_head_when_batch_reaches_head(self):
        cursor = self.HEAD - 20
        start, end = compute_scan_range(cursor, self.HEAD, self.WINDOW, 10_000_000)
        self.assertEqual(start, self.floor())
        self.assertEqual(end, self.HEAD)

    def test_cursor_ahead_of_head_reorg_uses_floor(self):
        # Reorg / clock skew left the cursor at or past the head → re-scan the
        # overlap window (idempotent) rather than an empty or negative range.
        self.assertEqual(
            compute_from_block(self.HEAD + 50, self.HEAD, self.WINDOW), self.floor()
        )

    def test_cursor_equal_to_head_uses_floor(self):
        # Boundary: cursor == head means "nothing new"; re-scan the window.
        self.assertEqual(
            compute_from_block(self.HEAD, self.HEAD, self.WINDOW), self.floor()
        )

    def test_cursor_exactly_one_behind_still_uses_floor(self):
        # Boundary: cursor == head - 1 still re-scans the overlap window.
        self.assertEqual(
            compute_from_block(self.HEAD - 1, self.HEAD, self.WINDOW), self.floor()
        )

    def test_cursor_at_window_boundary_prefers_cursor(self):
        # cursor + 1 exactly equals the floor → both agree (no off-by-one gap).
        cursor = self.floor() - 1
        self.assertEqual(
            compute_from_block(cursor, self.HEAD, self.WINDOW), self.floor()
        )

    def test_never_negative_near_genesis(self):
        # Window larger than the head must clamp the floor to 0, never go negative.
        self.assertEqual(compute_from_block(None, 5, 250), 0)
        # A low cursor near genesis clamps to 0 too (the floor is already 0 and the
        # lookback bound never pushes the start negative).
        self.assertEqual(compute_from_block(2, 5, 250), 0)
        self.assertGreaterEqual(compute_from_block(2, 5, 250), 0)
        # A None cursor with head 0 and any window clamps to 0 (not -249).
        self.assertEqual(compute_from_block(None, 0, 250), 0)


class BlockAuthorTest(unittest.TestCase):
    class QueryResult:
        def __init__(self, value):
            self.value = value

    class Substrate:
        def query(self, module, storage, block_hash=None):
            return BlockAuthorTest.QueryResult(["0x00", "0x01", "0x02"])

        def ss58_encode(self, pubkey):
            return f"5AUTHORITY{pubkey}"

    def header(self, data):
        return {"digest": {"logs": [{"PreRuntime": [AURA_ENGINE_ID, data]}]}}

    def test_aura_digest_requires_exactly_eight_slot_bytes(self):
        substrate = self.Substrate()
        for data in ("0x", "0x01", "0x01000000000000", "0x010000000000000000"):
            with self.subTest(data=data):
                self.assertIsNone(
                    _block_author(substrate, "0xblock", self.header(data))
                )

    def test_aura_digest_decodes_eight_byte_slot(self):
        substrate = self.Substrate()
        self.assertEqual(
            _block_author(substrate, "0xblock", self.header("0x0100000000000000")),
            "5AUTHORITY01",
        )


class ParseCursorTest(unittest.TestCase):
    def test_none_and_blank_are_cold(self):
        self.assertIsNone(_parse_cursor(None))
        self.assertIsNone(_parse_cursor(""))
        self.assertIsNone(_parse_cursor("   "))

    def test_numeric_string_parses(self):
        self.assertEqual(_parse_cursor("12345"), 12345)
        self.assertEqual(_parse_cursor(" 42 "), 42)
        self.assertEqual(_parse_cursor(0), 0)

    def test_garbage_is_cold(self):
        self.assertIsNone(_parse_cursor("abc"))
        self.assertIsNone(_parse_cursor("12.5"))
        self.assertIsNone(_parse_cursor("<cold start>"))

    def test_negative_is_cold(self):
        self.assertIsNone(_parse_cursor("-1"))
        self.assertIsNone(_parse_cursor(-7))


_lag_alert_needed = _fe._lag_alert_needed


class LagAlertNeededTest(unittest.TestCase):
    def test_cold_cursor_never_alerts(self):
        self.assertFalse(_lag_alert_needed(10_000, None, window=256, horizon=300))

    def test_alerts_at_and_above_the_overlap_floor(self):
        # floor = horizon - window = 44; lag >= 44 alerts, below does not.
        self.assertFalse(
            _lag_alert_needed(10_000, 10_000 - 43, window=256, horizon=300)
        )
        self.assertTrue(
            _lag_alert_needed(10_000, 10_000 - 44, window=256, horizon=300)
        )
        self.assertTrue(
            _lag_alert_needed(10_000, 10_000 - 100, window=256, horizon=300)
        )

    def test_window_ge_horizon_never_alerts(self):
        # When the overlap window covers the whole prune horizon, blocks can never
        # age out unseen — must NOT alert (regression: a bare horizon-window
        # threshold goes <= 0 and would fire every run, even at lag 0).
        self.assertFalse(_lag_alert_needed(10_000, 10_000, window=300, horizon=300))
        self.assertFalse(_lag_alert_needed(10_000, 9_000, window=300, horizon=300))
        self.assertFalse(_lag_alert_needed(10_000, 9_000, window=400, horizon=300))


_extract = _fe.extract
_SS58_A = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
_SS58_B = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"
_RAO_100 = 100_000_000_000  # 100 TAO in rao


class TransferExtractorTest(unittest.TestCase):
    """Tests for the Balances.Transfer extractor (#1814)."""

    def test_list_form_positional(self):
        # Older runtimes emit [from, to, amount] as positional list
        result = _extract("Transfer", [_SS58_A, _SS58_B, _RAO_100])
        self.assertEqual(result["hotkey"], _SS58_A)
        self.assertEqual(result["coldkey"], _SS58_B)
        self.assertAlmostEqual(result["amount_tao"], 100.0)
        self.assertIsNone(result["netuid"])
        self.assertIsNone(result["uid"])

    def test_dict_form_named(self):
        # Newer runtimes emit named-field dict
        result = _extract("Transfer", {"from": _SS58_A, "to": _SS58_B, "amount": _RAO_100})
        self.assertEqual(result["hotkey"], _SS58_A)
        self.assertEqual(result["coldkey"], _SS58_B)
        self.assertAlmostEqual(result["amount_tao"], 100.0)

    def test_zero_amount(self):
        result = _extract("Transfer", [_SS58_A, _SS58_B, 0])
        self.assertAlmostEqual(result["amount_tao"], 0.0)

    def test_invalid_from_gives_null_hotkey(self):
        result = _extract("Transfer", ["not-an-address", _SS58_B, _RAO_100])
        self.assertIsNone(result["hotkey"])
        self.assertEqual(result["coldkey"], _SS58_B)

    def test_invalid_to_gives_null_coldkey(self):
        result = _extract("Transfer", [_SS58_A, "not-an-address", _RAO_100])
        self.assertEqual(result["hotkey"], _SS58_A)
        self.assertIsNone(result["coldkey"])

    def test_missing_amount_gives_null(self):
        result = _extract("Transfer", [_SS58_A, _SS58_B])
        self.assertIsNone(result["amount_tao"])

    def test_non_transfer_balances_event_ignored(self):
        # Balances.Deposit, Balances.Reserved, etc. — no extractor → None
        self.assertIsNone(_extract("Deposit", [_SS58_A, _RAO_100]))
        self.assertIsNone(_extract("Reserved", [_SS58_A, _RAO_100]))

    def test_shape_drift_never_raises(self):
        # Completely wrong shape (empty list) must never raise — all fields null
        result = _extract("Transfer", [])
        self.assertIsNotNone(result)
        self.assertIsNone(result["hotkey"])
        self.assertIsNone(result["coldkey"])
        self.assertIsNone(result["amount_tao"])


class _Ev:
    """Minimal stand-in for a decoded event (`.value` is the SCALE-decoded dict)."""

    def __init__(self, value):
        self.value = value


def _fee_paid(idx, fee_rao, tip_rao):
    return _Ev(
        {
            "phase": "ApplyExtrinsic",
            "extrinsic_idx": idx,
            "event": {
                "module_id": "TransactionPayment",
                "event_id": "TransactionFeePaid",
                "attributes": ["5Who", fee_rao, tip_rao],
            },
        }
    )


class TipMapTest(unittest.TestCase):
    def test_tip_map_reads_the_third_attribute(self):
        # tip is the 3rd field [who, actual_fee, tip]; converted rao -> TAO (#1855).
        tip_map = _fe._tip_map([_fee_paid(0, 12_500_000, 500_000_000)])
        self.assertAlmostEqual(tip_map[0], 0.5)

    def test_tip_map_dict_attributes(self):
        ev = _Ev(
            {
                "phase": "ApplyExtrinsic",
                "extrinsic_idx": 3,
                "event": {
                    "module_id": "TransactionPayment",
                    "event_id": "TransactionFeePaid",
                    "attributes": {"who": "5Who", "actual_fee": 1, "tip": 2_000_000_000},
                },
            }
        )
        self.assertAlmostEqual(_fe._tip_map([ev])[3], 2.0)

    def test_tip_map_ignores_non_feepaid_and_non_apply_phase(self):
        other_module = _Ev(
            {
                "phase": "ApplyExtrinsic",
                "extrinsic_idx": 0,
                "event": {"module_id": "Balances", "event_id": "Transfer", "attributes": []},
            }
        )
        init_phase = _Ev(
            {
                "phase": "Initialization",
                "event": {
                    "module_id": "TransactionPayment",
                    "event_id": "TransactionFeePaid",
                    "attributes": ["5Who", 1, 2],
                },
            }
        )
        self.assertEqual(_fe._tip_map([other_module, init_phase]), {})

    def test_tip_map_never_raises_on_shape_drift(self):
        self.assertEqual(_fe._tip_map([_Ev("not-a-dict"), _Ev({})]), {})


class StakeAlphaExtractorTest(unittest.TestCase):
    """The alpha leg of stake events (#1856): _stake reads a[3] = alpha_rao."""

    _ALPHA = 9_250_000_000  # 9.25 alpha (in rao units)

    def test_stake_added_carries_the_alpha_leg(self):
        # [coldkey, hotkey, tao_rao, alpha_rao, netuid]
        result = _extract(
            "StakeAdded", [_SS58_A, _SS58_B, _RAO_100, self._ALPHA, 7]
        )
        self.assertAlmostEqual(result["amount_tao"], 100.0)
        self.assertAlmostEqual(result["alpha_amount"], 9.25)
        self.assertEqual(result["netuid"], 7)

    def test_stake_removed_carries_the_alpha_leg(self):
        result = _extract(
            "StakeRemoved", [_SS58_A, _SS58_B, _RAO_100, self._ALPHA, 7]
        )
        self.assertAlmostEqual(result["alpha_amount"], 9.25)

    def test_missing_alpha_leg_is_null(self):
        # A short payload (no a[3]) → alpha_amount null, never raises.
        result = _extract("StakeAdded", [_SS58_A, _SS58_B, _RAO_100])
        self.assertIsNone(result["alpha_amount"])

    def test_non_stake_kind_has_no_alpha(self):
        # Transfer carries no alpha leg → null (extract() defaults the key).
        result = _extract("Transfer", [_SS58_A, _SS58_B, _RAO_100])
        self.assertIsNone(result["alpha_amount"])


class TakeDelegateExtractorTest(unittest.TestCase):
    # Subtensor emits TakeIncreased/TakeDecreased/DelegateAdded coldkey-first:
    # Event::Take*(coldkey, hotkey, take). The positional list must map a[0] to
    # coldkey and a[1] to hotkey — not the reverse.
    def test_take_increased_positional_is_coldkey_first(self):
        result = _extract("TakeIncreased", [_SS58_A, _SS58_B, 100])
        self.assertEqual(result["coldkey"], _SS58_A)
        self.assertEqual(result["hotkey"], _SS58_B)

    def test_take_decreased_positional_is_coldkey_first(self):
        result = _extract("TakeDecreased", [_SS58_A, _SS58_B, 50])
        self.assertEqual(result["coldkey"], _SS58_A)
        self.assertEqual(result["hotkey"], _SS58_B)

    def test_take_changed_named_dict_form(self):
        result = _extract("TakeIncreased", {"coldkey": _SS58_A, "hotkey": _SS58_B})
        self.assertEqual(result["coldkey"], _SS58_A)
        self.assertEqual(result["hotkey"], _SS58_B)

    def test_take_matches_delegate_added_key_order(self):
        # Identical (coldkey, hotkey, take) shape → identical key mapping.
        take = _extract("TakeIncreased", [_SS58_A, _SS58_B, 100])
        delegate = _extract("DelegateAdded", [_SS58_A, _SS58_B, 100])
        self.assertEqual(take["coldkey"], delegate["coldkey"])
        self.assertEqual(take["hotkey"], delegate["hotkey"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
