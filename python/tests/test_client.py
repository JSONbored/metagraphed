"""Hermetic tests for the metagraphed client (urllib mocked, no network)."""

import json
import unittest
import urllib.error
import urllib.request
from unittest import mock

import metagraphed.client as client

from metagraphed import (
    MetagraphedClient,
    MetagraphedError,
    Subnet,
    Surface,
    metagraphed_fetch,
    metagraphed_fetch_all,
    metagraphed_paginate,
    metagraphed_rpc,
)


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

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
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

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            metagraphed_fetch(
                "/api/v1/search",
                query={"q": "image gen", "cursor": None, "limit": 5},
            )

        self.assertIn("q=image+gen", captured["url"])
        self.assertIn("limit=5", captured["url"])
        self.assertNotIn("cursor", captured["url"])

    def test_bool_query_values_serialize_lowercase(self):
        # Python's str(True) is "True", but the API compares query params
        # === "true"; a bool filter must be sent as the lowercase wire form or it
        # is silently ignored (regression: validator_permit=True was dropped, so
        # the request returned unfiltered results).
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            return _FakeResponse({"ok": True})

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            metagraphed_fetch(
                "/api/v1/subnets/7/metagraph",
                query={"validator_permit": True, "changes": False},
            )

        self.assertIn("validator_permit=true", captured["url"])
        self.assertIn("changes=false", captured["url"])
        self.assertNotIn("True", captured["url"])
        self.assertNotIn("False", captured["url"])

    def test_sequence_query_values_expand_and_coerce(self):
        # A list value expands via doseq; bools nested in it coerce element-wise
        # to the same lowercase wire form.
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            return _FakeResponse({"ok": True})

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            metagraphed_fetch(
                "/api/v1/surfaces",
                query={"kind": ["docs", "openapi"], "flags": [True, False]},
            )

        self.assertIn("kind=docs", captured["url"])
        self.assertIn("kind=openapi", captured["url"])
        self.assertIn("flags=true", captured["url"])
        self.assertIn("flags=false", captured["url"])

    def test_base_url_override(self):
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            return _FakeResponse({"ok": True})

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            MetagraphedClient(base_url="https://metagraph.sh").fetch("/api/v1/health")

        self.assertTrue(
            captured["url"].startswith("https://metagraph.sh/api/v1/health")
        )

    def test_http_error_becomes_metagraphed_error(self):
        def fake_urlopen(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, None)

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
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

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            metagraphed_fetch("/api/v1/health")

        self.assertIsNotNone(captured["ua"])
        self.assertTrue(captured["ua"].startswith("metagraphed-python/"))

    def test_caller_can_override_user_agent(self):
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["ua"] = request.get_header("User-agent")
            return _FakeResponse({"ok": True})

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            metagraphed_fetch("/api/v1/health", headers={"User-Agent": "my-app/1.0"})

        self.assertEqual(captured["ua"], "my-app/1.0")

    def test_cross_origin_redirect_strips_custom_headers(self):
        request = urllib.request.Request("https://api.example.test/v1", method="GET")
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", "metagraphed-python/test")
        request.add_header("Authorization", "Bearer SECRET")
        request.add_header("X-Api-Key", "SECRET")
        request.add_header("Cookie", "session=SECRET")

        redirected = client._CrossOriginSafeRedirectHandler().redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "https://attacker.example.test/collect",
        )

        self.assertIsNotNone(redirected)
        self.assertEqual(redirected.get_header("Accept"), "application/json")
        self.assertEqual(
            redirected.get_header("User-agent"), "metagraphed-python/test"
        )
        self.assertIsNone(redirected.get_header("Authorization"))
        self.assertIsNone(redirected.get_header("X-api-key"))
        self.assertIsNone(redirected.get_header("Cookie"))

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

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            with self.assertRaises(MetagraphedError) as ctx:
                metagraphed_fetch(
                    "/api/v1/subnets/{netuid}", path_params={"netuid": 9999}
                )
        self.assertEqual(ctx.exception.status, 404)
        self.assertIn("no such subnet", str(ctx.exception))

    def test_http_error_with_non_string_error_code_is_exception_safe(self):
        import io

        def fake_urlopen(request, timeout=None):
            body = io.BytesIO(
                json.dumps(
                    {
                        "ok": False,
                        "error": {"code": 123, "message": "nonconforming upstream"},
                    }
                ).encode("utf-8")
            )
            raise urllib.error.HTTPError(request.full_url, 502, "Bad Gateway", {}, body)

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            with self.assertRaises(MetagraphedError) as ctx:
                metagraphed_fetch("/api/v1/health")
        self.assertEqual(ctx.exception.status, 502)
        self.assertIn("123 — nonconforming upstream", str(ctx.exception))

    def test_non_json_response_raises_metagraphed_error(self):
        class _BadResponse(_FakeResponse):
            def __init__(self):
                self._body = b"<html>not json</html>"

        with mock.patch(
            "metagraphed.client._open_request",
            lambda request, timeout=None: _BadResponse(),
        ):
            with self.assertRaises(MetagraphedError):
                metagraphed_fetch("/api/v1/health")

    def test_retries_transient_error_then_succeeds(self):
        calls = {"n": 0}

        def fake_urlopen(request, timeout=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise urllib.error.HTTPError(request.full_url, 503, "busy", {}, None)
            return _FakeResponse({"ok": True, "data": {"healthy": True}})

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            out = metagraphed_fetch("/api/v1/health", retries=1, backoff=0)

        self.assertEqual(calls["n"], 2)
        self.assertTrue(out["data"]["healthy"])

    def test_retry_after_is_capped_and_overflow_safe(self):
        sleeps = []
        calls = {"n": 0}

        def fake_urlopen(request, timeout=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise urllib.error.HTTPError(
                    request.full_url,
                    503,
                    "busy",
                    {"Retry-After": "315360000"},
                    None,
                )
            if calls["n"] == 2:
                raise urllib.error.HTTPError(
                    request.full_url,
                    503,
                    "busy",
                    {"Retry-After": "9" * 400},
                    None,
                )
            return _FakeResponse({"ok": True})

        with mock.patch("metagraphed.client._open_request", fake_urlopen), mock.patch(
            "time.sleep", lambda seconds: sleeps.append(seconds)
        ):
            out = metagraphed_fetch("/api/v1/health", retries=2, backoff=0)

        self.assertEqual(out, {"ok": True})
        self.assertEqual(sleeps, [60.0, 0])

    def test_retries_exhausted_raises(self):
        def fake_urlopen(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 503, "busy", {}, None)

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            with self.assertRaises(MetagraphedError) as ctx:
                metagraphed_fetch("/api/v1/health", retries=2, backoff=0)
        self.assertEqual(ctx.exception.status, 503)

    def test_paginate_follows_next_cursor(self):
        pages = [
            {"ok": True, "data": [1], "meta": {"pagination": {"next_cursor": "2"}}},
            {"ok": True, "data": [2], "meta": {"pagination": {"next_cursor": None}}},
        ]
        captured_urls = []
        state = {"i": 0}

        def fake_urlopen(request, timeout=None):
            captured_urls.append(request.full_url)
            page = pages[state["i"]]
            state["i"] += 1
            return _FakeResponse(page)

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            seen = [
                page["data"][0]
                for page in metagraphed_paginate("/api/v1/subnets", query={"limit": 1})
            ]

        self.assertEqual(seen, [1, 2])
        self.assertIn("cursor=2", captured_urls[1])

    def test_rpc_posts_jsonrpc_and_returns_result(self):
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            captured["method"] = request.get_method()
            captured["body"] = request.data
            return _FakeResponse({"jsonrpc": "2.0", "id": 1, "result": {"peers": 40}})

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            result = metagraphed_rpc("finney", "system_health")

        self.assertEqual(result, {"peers": 40})
        self.assertEqual(captured["url"], "https://api.metagraph.sh/rpc/v1/finney")
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(json.loads(captured["body"])["method"], "system_health")

    def test_rpc_jsonrpc_error_raises(self):
        def fake_urlopen(request, timeout=None):
            return _FakeResponse(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "error": {"code": -32601, "message": "Method not found"},
                }
            )

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            with self.assertRaises(MetagraphedError) as ctx:
                metagraphed_rpc("finney", "nope")
        self.assertIn("Method not found", str(ctx.exception))

    def test_rpc_retries_transient_error_then_succeeds(self):
        calls = {"n": 0}

        def fake_urlopen(request, timeout=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise urllib.error.HTTPError(request.full_url, 503, "busy", {}, None)
            return _FakeResponse({"jsonrpc": "2.0", "id": 1, "result": {"peers": 7}})

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            result = metagraphed_rpc(
                "finney", "system_health", retries=1, backoff=0
            )

        self.assertEqual(calls["n"], 2)
        self.assertEqual(result, {"peers": 7})

    def test_rpc_retries_network_error_then_succeeds(self):
        calls = {"n": 0}

        def fake_urlopen(request, timeout=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise urllib.error.URLError("connection reset")
            return _FakeResponse({"jsonrpc": "2.0", "id": 1, "result": "0xabc"})

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            result = metagraphed_rpc(
                "finney", "chain_getBlockHash", [0], retries=1, backoff=0
            )

        self.assertEqual(calls["n"], 2)
        self.assertEqual(result, "0xabc")

    def test_rpc_retries_exhausted_raises_after_configured_count(self):
        calls = {"n": 0}

        def fake_urlopen(request, timeout=None):
            calls["n"] += 1
            raise urllib.error.HTTPError(request.full_url, 503, "busy", {}, None)

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            with self.assertRaises(MetagraphedError) as ctx:
                metagraphed_rpc("finney", "system_health", retries=2, backoff=0)

        # Initial attempt + 2 retries, then it gives up.
        self.assertEqual(calls["n"], 3)
        self.assertEqual(ctx.exception.status, 503)

    def test_client_rpc_forwards_configured_retries_and_backoff(self):
        calls = {"n": 0}

        def fake_urlopen(request, timeout=None):
            calls["n"] += 1
            if calls["n"] <= 2:
                raise urllib.error.HTTPError(request.full_url, 503, "busy", {}, None)
            return _FakeResponse({"jsonrpc": "2.0", "id": 1, "result": "ok"})

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            result = MetagraphedClient(retries=2, backoff=0).rpc(
                "finney", "system_health"
            )

        self.assertEqual(calls["n"], 3)
        self.assertEqual(result, "ok")


class FetchAllAndModelsTest(unittest.TestCase):
    def _patch_pages(self, pages):
        responses = iter(_FakeResponse(page) for page in pages)

        def fake_urlopen(request, timeout=None):
            return next(responses)

        return mock.patch("metagraphed.client._open_request", fake_urlopen)

    def test_fetch_all_collects_nested_collection_following_cursor(self):
        # List endpoints nest rows under data[meta.pagination.collection].
        pages = [
            {
                "data": {"subnets": [{"netuid": 1}]},
                "meta": {"pagination": {"collection": "subnets", "next_cursor": "c2"}},
            },
            {
                "data": {"subnets": [{"netuid": 2}]},
                "meta": {"pagination": {"collection": "subnets", "next_cursor": None}},
            },
        ]
        with self._patch_pages(pages):
            items = metagraphed_fetch_all("/api/v1/subnets")
        self.assertEqual([item["netuid"] for item in items], [1, 2])

    def test_fetch_all_falls_back_to_flat_and_lone_array(self):
        flat = [{"data": [{"id": "a"}], "meta": {"pagination": {"next_cursor": None}}}]
        with self._patch_pages(flat):
            self.assertEqual(metagraphed_fetch_all("/api/v1/subnets"), [{"id": "a"}])
        # No collection key, but data has a single list-valued field.
        lone = [
            {
                "data": {"rows": [{"id": "b"}]},
                "meta": {"pagination": {"next_cursor": None}},
            }
        ]
        with self._patch_pages(lone):
            self.assertEqual(metagraphed_fetch_all("/api/v1/subnets"), [{"id": "b"}])

    def test_subnets_convenience_returns_typed_models(self):
        pages = [
            {
                "data": [{"netuid": 7, "name": "Allways", "categories": ["inference"]}],
                "meta": {"pagination": {"next_cursor": None}},
            }
        ]
        with self._patch_pages(pages):
            subnets = MetagraphedClient().subnets()
        self.assertIsInstance(subnets[0], Subnet)
        self.assertEqual(subnets[0].netuid, 7)
        self.assertEqual(subnets[0].name, "Allways")
        self.assertEqual(subnets[0].categories, ["inference"])
        self.assertEqual(subnets[0].raw["name"], "Allways")

    def test_model_from_dict_ignores_unknown_and_keeps_raw(self):
        surface = Surface.from_dict(
            {"id": "x", "kind": "openapi", "unknown_field": 1}
        )
        self.assertEqual(surface.id, "x")
        self.assertEqual(surface.kind, "openapi")
        self.assertEqual(surface.raw["unknown_field"], 1)

    def test_model_from_dict_tolerates_non_mapping(self):
        self.assertEqual(Subnet.from_dict(None).raw, {})
        self.assertIsNone(Subnet.from_dict(None).netuid)


if __name__ == "__main__":
    unittest.main()
