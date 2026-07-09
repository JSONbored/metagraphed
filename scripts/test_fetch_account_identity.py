#!/usr/bin/env python3
"""Unit tests for fetch-account-identity.py's pure helpers (#4324/5.1).

Runnable both ways:

    python3 scripts/test_fetch_account_identity.py
    python3 -m pytest scripts/test_fetch_account_identity.py

Loaded by path (hyphenated filename), same convention as
test_fetch_subnet_hyperparams.py. Does not import the real `bittensor`
package — these are pure functions with no SDK dependency.
"""
import importlib.util
import os
import unittest

_FAI_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fetch-account-identity.py"
)
_spec = importlib.util.spec_from_file_location(
    "fetch_account_identity_under_test", _FAI_PATH
)
_fai = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fai)

_at = _fai._at
blank_to_null = _fai.blank_to_null


class AtTest(unittest.TestCase):
    def test_in_range_index_returns_value(self):
        self.assertEqual(_at(["a", "b"], 1), "b")

    def test_out_of_range_index_returns_none(self):
        self.assertIsNone(_at(["a"], 5))

    def test_empty_list_returns_none(self):
        self.assertIsNone(_at([], 0))


class BlankToNullTest(unittest.TestCase):
    def test_empty_string_is_null(self):
        self.assertIsNone(blank_to_null(""))

    def test_whitespace_only_is_null(self):
        self.assertIsNone(blank_to_null("   "))

    def test_none_is_null(self):
        self.assertIsNone(blank_to_null(None))

    def test_non_string_is_null(self):
        self.assertIsNone(blank_to_null(5))

    def test_real_value_passes_through(self):
        self.assertEqual(blank_to_null("Example Team"), "Example Team")

    def test_surrounding_whitespace_is_stripped(self):
        self.assertEqual(blank_to_null("  Example  "), "Example")


if __name__ == "__main__":
    unittest.main()
