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
decode_le_uint = _fns.decode_le_uint
decode_optional_bool = _fns.decode_optional_bool
normalize_pipeline = _fns.normalize_pipeline
fetch_pipeline_state = _fns.fetch_pipeline_state
U96F32_SCALE = _fns.U96F32_SCALE
U64F64_SCALE = _fns.U64F64_SCALE


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
        self.assertEqual(int(result["total_stake_alpha"]), expected_whole_tao)
        self.assertEqual(result["max_stake_alpha"], rao_to_tao_exact(max(s.rao for s in stakes)))

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
        self.assertIsNone(result["total_stake_alpha"])
        self.assertIsNone(result["max_stake_alpha"])


# --- v440 emission-pipeline inputs (#8743) --------------------------------
#
# Every hex value below is a REAL storage read from finney, captured
# 2026-07-31 around block 8,740,213 -- not a hand-assembled word. A decoder
# tested against invented bytes tests only my belief about the encoding.


class DecodeLeUintTests(unittest.TestCase):
    def test_decodes_real_u64_storage_values(self):
        # SubnetExcessTao[1] and FirstEmissionBlockNumber[1].
        self.assertEqual(decode_le_uint("0xaeea100000000000", 8), 1_108_654)
        self.assertEqual(decode_le_uint("0x8bc84f0000000000", 8), 5_228_683)

    def test_decodes_miner_burned_as_a_128_bit_word(self):
        # MinerBurned[1], U96F32. Read as 8 bytes it would be a different
        # number entirely, which is the whole trap.
        raw = "0x00000000000000000000000000000000"
        self.assertEqual(decode_le_uint(raw, 16), 0)

    def test_returns_none_for_absent_or_short_values(self):
        # A partial read must never be interpreted as a small number.
        for bad in (None, "", "not-hex", "0x", "0xaeea", 42, {}):
            self.assertIsNone(decode_le_uint(bad, 8))
        self.assertIsNone(decode_le_uint("0xaeea100000000000", 16))

    def test_returns_none_for_non_hex_body(self):
        self.assertIsNone(decode_le_uint("0xzzzzzzzzzzzzzzzz", 8))


class DecodeOptionalBoolTests(unittest.TestCase):
    def test_absence_takes_the_runtime_default(self):
        # SubnetEmissionEnabled defaults to TRUE. Measured on finney
        # 2026-07-31: 57 of 127 subnets have NO entry and are enabled by
        # default. Reading absence as false mislabels every one of them.
        self.assertTrue(decode_optional_bool(None, True))
        self.assertFalse(decode_optional_bool(None, False))

    def test_explicit_values_win_over_the_default(self):
        self.assertFalse(decode_optional_bool("0x00", True))
        self.assertTrue(decode_optional_bool("0x01", False))

    def test_unrecognised_encoding_falls_back_to_the_default(self):
        self.assertTrue(decode_optional_bool("0xff", True))
        self.assertFalse(decode_optional_bool("0xff", False))


def _le_hex(value, byte_len):
    """A storage value as the chain encodes it: little-endian, 0x-prefixed.

    Built rather than typed: hand-writing a 16-byte LE word is exactly the
    kind of thing that looks right and decodes to something else.
    """
    return "0x" + int(value).to_bytes(byte_len, "little").hex()


def _pipeline_state(**overrides):
    """A pipeline read set shaped like fetch_pipeline_state's return."""
    by_item = {
        "miner_burned": {1: _le_hex(round(0.10682435240596533 * U96F32_SCALE), 16)},
        "emission_enabled": {},
        "excess_tao": {1: "0xaeea100000000000"},
        "first_emission_block": {1: "0x8bc84f0000000000"},
        "subtoken_enabled": {1: "0x01"},
        "tao_in_emission": {1: "0x0f19120000000000"},
        "alpha_in_emission": {1: _le_hex(0, 8)},
        "alpha_out_emission": {1: _le_hex(1_000_000_000, 8)},
        # #8744: stage 1's input and stage 0's last gate, now pinned.
        "moving_price": {1: _le_hex(round(0.25 * U64F64_SCALE), 16)},
        "registration_allowed": {1: "0x01"},
    }
    for key, value in overrides.items():
        by_item[key] = value
    return {
        "block": 8_740_213,
        "block_hash": "0x0f",
        "total_issuance_rao": 1,
        "gate_params": {
            "emission_gate_bar": round(0.00927284254359668 * U64F64_SCALE),
            "emission_bar_quantile": round(0.75 * U64F64_SCALE),
            "emission_gate_exponent": None,
        },
        "by_item": by_item,
    }


class NormalizePipelineTests(unittest.TestCase):
    def test_decodes_a_real_subnet(self):
        row = normalize_pipeline(_pipeline_state(), 1)
        self.assertEqual(row["first_emission_block"], 5_228_683)  # 0x8bc84f00.. LE
        self.assertEqual(row["excess_tao"], rao_to_tao_exact(1_108_654))
        self.assertTrue(row["subtoken_enabled"])
        # 1 TAO in rao -- alpha_out_emission is a real per-subnet halving
        # curve that happens to read 1.0 for almost every subnet today.
        self.assertEqual(row["alpha_out_emission"], 1.0)

    def test_absent_emission_flag_means_enabled(self):
        # The single highest-consequence default in this file.
        self.assertTrue(normalize_pipeline(_pipeline_state(), 1)["emission_enabled"])
        state = _pipeline_state(emission_enabled={1: "0x00"})
        self.assertFalse(normalize_pipeline(state, 1)["emission_enabled"])

    def test_miner_burned_scales_by_two_to_the_32(self):
        # NOT by 1e9. Scaling it as rao lands ~4e9 out and is what put an
        # earlier reconstruction at 5.4e-4 mean share error instead of 4.3e-8.
        row = normalize_pipeline(_pipeline_state(), 1)
        self.assertAlmostEqual(row["miner_burned_fraction"], 0.10682435240596533, places=12)

    def test_miner_burned_is_a_fraction_not_an_amount(self):
        # Verified against all 127 subnets on finney: every non-zero value
        # falls in (0, 1] with a maximum of exactly 1.0.
        one = _le_hex(U96F32_SCALE, 16)
        row = normalize_pipeline(_pipeline_state(miner_burned={1: one}), 1)
        self.assertEqual(row["miner_burned_fraction"], 1.0)

    def test_absent_amounts_are_zero_not_null(self):
        # Zero is a real measurement -- a disabled subnet genuinely receives
        # nothing on both TAO channels. Null would mean "we did not look".
        row = normalize_pipeline(_pipeline_state(excess_tao={}, tao_in_emission={}), 1)
        self.assertEqual(row["excess_tao"], 0)
        self.assertEqual(row["tao_in_emission_tao"], 0)

    def test_absent_miner_burned_is_null_not_zero(self):
        # Unlike the amounts: a missing fraction is unknown, and zero would
        # assert "no miner burn", which is a different claim.
        row = normalize_pipeline(_pipeline_state(miner_burned={}), 1)
        self.assertIsNone(row["miner_burned_fraction"])

    def test_no_pipeline_state_yields_no_keys(self):
        # A node that cannot serve state_queryStorageAt costs the pipeline
        # fields, never the whole snapshot.
        self.assertEqual(normalize_pipeline(None, 1), {})

    def test_economics_merges_the_pipeline_block(self):
        info = types.SimpleNamespace(
            validator_permit=[True], num_uids=1, max_uids=1, max_validators=1,
            registration_allowed=True, burn=None, moving_price=None, total_stake=[],
            tao_in=None, alpha_in=None, alpha_out=None, subnet_volume=None,
            owner_hotkey="", owner_coldkey="",
        )
        merged = normalize_economics(info, normalize_pipeline(_pipeline_state(), 1))
        self.assertTrue(merged["emission_enabled"])
        self.assertEqual(merged["first_emission_block"], 5_228_683)
        # The MetagraphInfo-derived keys still come through untouched.
        self.assertEqual(merged["validator_count"], 1)

    def test_economics_without_a_pipeline_omits_the_keys(self):
        info = types.SimpleNamespace(
            validator_permit=[], num_uids=0, max_uids=0, max_validators=0,
            registration_allowed=False, burn=None, moving_price=None, total_stake=[],
            tao_in=None, alpha_in=None, alpha_out=None, subnet_volume=None,
            owner_hotkey="", owner_coldkey="",
        )
        self.assertNotIn("emission_enabled", normalize_economics(info, None))


class FetchPipelineStateTests(unittest.TestCase):
    class _FakeSubstrate:
        """Answers the three RPCs fetch_pipeline_state makes."""

        def __init__(self, changes_by_item=None, reversed_order=False):
            self.changes_by_item = changes_by_item or {}
            self.reversed_order = reversed_order
            self.requests = []

        def get_chain_head(self):
            return "0xhead"

        def rpc_request(self, method, params):
            self.requests.append((method, params))
            if method == "chain_getHeader":
                return {"result": {"number": "0x855bb5"}}
            if method == "state_getStorage":
                return {"result": "0xb7d6eeb1b2b92700"}
            keys = params[0]
            changes = [[key, "0x0100000000000000"] for key in keys]
            if self.reversed_order:
                changes.reverse()
            return {"result": [{"changes": changes}]}

    def test_pins_every_read_to_one_block(self):
        # theta recomputes when block % 360 == 0; reads straddling that
        # boundary mismatch for reasons unrelated to our arithmetic.
        sub = self._FakeSubstrate()
        state = fetch_pipeline_state(sub, [1, 2])
        self.assertEqual(state["block"], int("855bb5", 16))
        self.assertEqual(state["block_hash"], "0xhead")
        for method, params in sub.requests:
            if method in ("state_queryStorageAt", "state_getStorage"):
                self.assertEqual(params[1], "0xhead")

    def test_recovers_netuids_from_the_key_not_the_order(self):
        # state_queryStorageAt may answer in any order; trusting position
        # would attribute one subnet's emission to another.
        forward = fetch_pipeline_state(self._FakeSubstrate(), [1, 2, 300])
        backward = fetch_pipeline_state(self._FakeSubstrate(reversed_order=True), [1, 2, 300])
        self.assertEqual(forward["by_item"], backward["by_item"])
        self.assertEqual(sorted(forward["by_item"]["excess_tao"]), [1, 2, 300])

    def test_reads_total_issuance(self):
        state = fetch_pipeline_state(self._FakeSubstrate(), [1])
        self.assertEqual(state["total_issuance_rao"], 11_181_701_232_252_599)




class PinnedPipelineInputTests(unittest.TestCase):
    """#8744: stage 1's input and stage 0's last gate, read at the pinned block.

    #8743 took both off the bulk get_all_metagraphs_info call, which runs at
    its own height. The values were right; the INSTANT was not, and the
    reconstruction combines them with reads pinned to one block.
    """

    def test_moving_price_decodes_as_u64f64_not_rao(self):
        row = normalize_pipeline(_pipeline_state(), 1)
        self.assertAlmostEqual(row["moving_price_pinned"], 0.25, places=12)

    def test_moving_price_is_a_separate_field_from_alpha_price(self):
        # alpha_price_tao keeps its bulk-call source and its published meaning
        # (ADR 0023 decision 1). This is a second, pinned reading -- if the two
        # ever collapse into one key, the published field silently changes
        # provenance.
        row = normalize_pipeline(_pipeline_state(), 1)
        self.assertIn("moving_price_pinned", row)
        self.assertNotIn("alpha_price_tao", row)

    def test_absent_moving_price_is_none_not_zero(self):
        # Zero is a real price share; absent is not captured. Collapsing them
        # would hand a live subnet a stage-1 share of exactly 0.
        row = normalize_pipeline(_pipeline_state(moving_price={}), 1)
        self.assertIsNone(row["moving_price_pinned"])

    def test_registration_allowed_defaults_false_when_absent(self):
        # Unlike SubnetEmissionEnabled, NetworkRegistrationAllowed has no
        # true-by-default behaviour -- absent means not allowed.
        row = normalize_pipeline(_pipeline_state(registration_allowed={}), 1)
        self.assertFalse(row["registration_allowed_pinned"])
        explicit = normalize_pipeline(
            _pipeline_state(registration_allowed={1: "0x00"}), 1
        )
        self.assertFalse(explicit["registration_allowed_pinned"])

    def test_a_failed_item_read_costs_that_field_not_the_refresh(self):
        # by_item.get(item, {}) rather than [item]: one failed read of the
        # fourteen must not take the whole refresh down.
        state = _pipeline_state()
        del state["by_item"]["moving_price"]
        row = normalize_pipeline(state, 1)
        self.assertIsNone(row["moving_price_pinned"])
        self.assertEqual(row["first_emission_block"], 5_228_683)


if __name__ == "__main__":
    unittest.main()
