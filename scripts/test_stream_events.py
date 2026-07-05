#!/usr/bin/env python3
"""Unit tests for the realtime streamer's ingest-push auth handling (#2687).

stream-events.py is hyphenated, so it is loaded by path the same way
test_fetch_events.py loads fetch-events.py — no package rename needed. `push()`
is exercised with `urlopen` mocked; nothing here touches the network.

    python3 scripts/test_stream_events.py          # standalone (CI-friendly)
    python3 -m unittest scripts.test_stream_events # via the unittest runner
    python3 -m pytest scripts/test_stream_events.py # if pytest is available
"""
import importlib.util
import os
import unittest
import urllib.error
from unittest.mock import Mock, patch

_SE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "stream-events.py"
)
_spec = importlib.util.spec_from_file_location("stream_events_under_test", _SE_PATH)
_se = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_se)


def _http_error(code):
    return urllib.error.HTTPError(
        url="https://api.metagraph.sh/api/v1/internal/events",
        code=code,
        msg="error",
        hdrs=None,
        fp=None,
    )


class PushAuthFatalTest(unittest.TestCase):
    def test_401_exits_instead_of_retrying(self):
        with patch.object(_se.urllib.request, "urlopen", side_effect=_http_error(401)):
            with self.assertRaises(SystemExit) as cm:
                _se.push("https://api.metagraph.sh/api/v1/internal/events", {})
        self.assertEqual(cm.exception.code, 1)

    def test_403_exits_instead_of_retrying(self):
        with patch.object(_se.urllib.request, "urlopen", side_effect=_http_error(403)):
            with self.assertRaises(SystemExit) as cm:
                _se.push("https://api.metagraph.sh/api/v1/internal/events", {})
        self.assertEqual(cm.exception.code, 1)

    def test_permanent_http_error_returns_false_without_retrying(self):
        with patch.object(
            _se.urllib.request, "urlopen", side_effect=_http_error(413)
        ) as urlopen:
            with patch.object(_se.time, "sleep") as sleep:
                result = _se.push("https://api.metagraph.sh/api/v1/internal/blocks", {})
        self.assertFalse(result)
        self.assertEqual(urlopen.call_count, 1)
        sleep.assert_not_called()

    def test_other_http_error_retries_before_returning(self):
        ok_response = Mock()
        ok_response.__enter__ = Mock(return_value=ok_response)
        ok_response.__exit__ = Mock(return_value=None)
        ok_response.read = Mock(return_value=b"")
        with patch.object(
            _se.urllib.request,
            "urlopen",
            side_effect=[_http_error(500), ok_response],
        ) as urlopen:
            with patch.object(_se.time, "sleep") as sleep:
                result = _se.push("https://api.metagraph.sh/api/v1/internal/events", {})
        self.assertTrue(result)
        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(_se.PUSH_RETRY_INITIAL_SECONDS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
