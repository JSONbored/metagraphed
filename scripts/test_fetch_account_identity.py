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
identity_fields = _fai.identity_fields


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


class IdentityFieldsTest(unittest.TestCase):
    def test_maps_github_repo_to_the_shorter_github_key(self):
        # The live-verified chain field is "github_repo", not "github" — this
        # is the regression case for the bug the adversarial review caught:
        # the original implementation read a "github" attribute that never
        # existed on the (dict-shaped) identity, so every field silently
        # decoded to null.
        out = identity_fields({"github_repo": "https://github.com/example"})
        self.assertEqual(out["github"], "https://github.com/example")
        self.assertNotIn("github_repo", out)

    def test_extracts_every_field_from_a_full_dict(self):
        identity = {
            "name": "Example Team",
            "url": "https://example.com",
            "github_repo": "example",
            "image": "https://example.com/logo.png",
            "discord": "example#0001",
            "description": "An example subnet operator.",
            "additional": "extra info",
        }
        out = identity_fields(identity)
        self.assertEqual(
            out,
            {
                "name": "Example Team",
                "url": "https://example.com",
                "github": "example",
                "image": "https://example.com/logo.png",
                "discord": "example#0001",
                "description": "An example subnet operator.",
                "additional": "extra info",
            },
        )

    def test_blank_chain_fields_become_null(self):
        identity = {
            "name": "Example",
            "url": "",
            "github_repo": "",
            "image": "",
            "discord": "",
            "description": "",
            "additional": "",
        }
        out = identity_fields(identity)
        self.assertEqual(out["name"], "Example")
        for key in ("url", "github", "image", "discord", "description", "additional"):
            self.assertIsNone(out[key], key)

    def test_missing_key_becomes_null_not_a_crash(self):
        out = identity_fields({"name": "Example"})  # every other key absent
        self.assertEqual(out["name"], "Example")
        self.assertIsNone(out["url"])
        self.assertIsNone(out["github"])

    def test_non_dict_identity_degrades_to_all_null_fields(self):
        # Defensive: a future SDK change that stops returning a plain dict
        # (e.g. reverts to a dataclass instance) must not crash the fetch —
        # it should degrade to an all-null row, not raise.
        class NotADict:
            name = "should not be read via attribute access"

        out = identity_fields(NotADict())
        self.assertIsNone(out["name"])
        self.assertIsNone(out["github"])


if __name__ == "__main__":
    unittest.main()
