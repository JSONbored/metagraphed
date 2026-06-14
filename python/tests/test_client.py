"""Hermetic tests for the metagraphed client (urllib mocked, no network)."""

import json
import unittest
import urllib.error
from unittest import mock

from metagraphed import MetagraphedClient, MetagraphedError, metagraphed_fetch


class _FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class ClientTest(unittest.TestCase):
    def test_interpolates_path_params_and_sets_accept(self):
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            captured["accept"] = request.get_header("Accept")
            return _FakeResponse({"ok": True, "data": {"netuid": 7}})

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            out = metagraphed_fetch(
                "/api/v1/subnets/{netuid}", path_params={"netuid": 7}
            )

        self.assertEqual(captured["url"], "https://api.metagraph.sh/api/v1/subnets/7")
        self.assertEqual(captured["accept"], "application/json")
        self.assertEqual(out["data"]["netuid"], 7)

    def test_missing_path_param_raises(self):
        with self.assertRaises(MetagraphedError):
            metagraphed_fetch("/api/v1/subnets/{netuid}")

    def test_drops_none_query_values_and_encodes(self):
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            return _FakeResponse({"ok": True})

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            metagraphed_fetch(
                "/api/v1/search",
                query={"q": "image gen", "cursor": None, "limit": 5},
            )

        self.assertIn("q=image+gen", captured["url"])
        self.assertIn("limit=5", captured["url"])
        self.assertNotIn("cursor", captured["url"])

    def test_base_url_override(self):
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            return _FakeResponse({"ok": True})

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            MetagraphedClient(base_url="https://metagraph.sh").fetch("/api/v1/health")

        self.assertTrue(
            captured["url"].startswith("https://metagraph.sh/api/v1/health")
        )

    def test_http_error_becomes_metagraphed_error(self):
        def fake_urlopen(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, None)

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(MetagraphedError) as ctx:
                metagraphed_fetch("/api/v1/subnets/{netuid}", path_params={"netuid": 9999})
        self.assertEqual(ctx.exception.status, 404)

    def test_sets_descriptive_user_agent(self):
        # Regression: the Cloudflare WAF on api.metagraph.sh 403s the default
        # "Python-urllib/<ver>" UA, so a descriptive UA must be sent by default.
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["ua"] = request.get_header("User-agent")
            return _FakeResponse({"ok": True})

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            metagraphed_fetch("/api/v1/health")

        self.assertIsNotNone(captured["ua"])
        self.assertTrue(captured["ua"].startswith("metagraphed-python/"))

    def test_caller_can_override_user_agent(self):
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["ua"] = request.get_header("User-agent")
            return _FakeResponse({"ok": True})

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            metagraphed_fetch("/api/v1/health", headers={"User-Agent": "my-app/1.0"})

        self.assertEqual(captured["ua"], "my-app/1.0")

    def test_http_error_surfaces_api_error_envelope(self):
        import io

        def fake_urlopen(request, timeout=None):
            body = io.BytesIO(
                json.dumps(
                    {
                        "ok": False,
                        "error": {"code": "not_found", "message": "no such subnet"},
                    }
                ).encode("utf-8")
            )
            raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, body)

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(MetagraphedError) as ctx:
                metagraphed_fetch(
                    "/api/v1/subnets/{netuid}", path_params={"netuid": 9999}
                )
        self.assertEqual(ctx.exception.status, 404)
        self.assertIn("no such subnet", str(ctx.exception))

    def test_non_json_response_raises_metagraphed_error(self):
        class _BadResponse(_FakeResponse):
            def __init__(self):
                self._body = b"<html>not json</html>"

        with mock.patch(
            "urllib.request.urlopen", lambda request, timeout=None: _BadResponse()
        ):
            with self.assertRaises(MetagraphedError):
                metagraphed_fetch("/api/v1/health")


if __name__ == "__main__":
    unittest.main()
