#!/usr/bin/env python3
"""Unit tests for backfill-events.py trust-boundary helpers."""
import importlib.util
import os
import unittest
from unittest.mock import patch

_BE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "backfill-events.py"
)
_spec = importlib.util.spec_from_file_location("backfill_events_under_test", _BE_PATH)
_be = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_be)


class ArchiveTrustTest(unittest.TestCase):
    def test_default_archive_is_selected_when_env_is_blank(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(_be._select_archive_url(), _be.DEFAULT_ARCHIVE)

    def test_untrusted_archive_is_rejected(self):
        with patch.dict(
            os.environ,
            {"SUBTENSOR_RPC_URL": "ws://attacker.invalid/archive"},
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "not trusted"):
                _be._select_archive_url()

    def test_extra_trusted_archive_must_be_maintainer_configured(self):
        trusted = "wss://archive.example.org/subtensor"
        with patch.dict(
            os.environ,
            {
                "BACKFILL_TRUSTED_ARCHIVE_URLS": trusted,
                "SUBTENSOR_RPC_URL": trusted,
            },
            clear=True,
        ):
            self.assertEqual(_be._select_archive_url(), trusted)

    def test_non_websocket_urls_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "ws:// or wss://"):
            _be._normalize_url("https://bittensor-finney.api.onfinality.io/public")


class ChainVerificationTest(unittest.TestCase):
    class Substrate:
        def __init__(self, genesis):
            self.genesis = genesis

        def get_block_hash(self, block_number):
            if block_number != 0:
                raise AssertionError(f"unexpected block lookup: {block_number}")
            return self.genesis

    def test_finney_genesis_is_accepted(self):
        _be._verify_finney_chain(self.Substrate(_be.FINNEY_GENESIS_HASH.upper()))

    def test_wrong_genesis_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "genesis hash mismatch"):
            _be._verify_finney_chain(self.Substrate("0xother"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
