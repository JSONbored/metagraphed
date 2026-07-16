"""Hermetic tests for the metagraphed client (urllib mocked, no network)."""

import json
import unittest
import urllib.error
import urllib.request
from unittest import mock

import metagraphed.client as client

from metagraphed import (
    AgentCatalogSubnet,
    Endpoint,
    MetagraphedClient,
    MetagraphedError,
    Provider,
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

    def test_next_cursor_is_defensive_against_malformed_pages(self):
        # Mirrors _collection_rows' guards: a non-dict page, a null/absent meta,
        # or a null/absent pagination must yield None (terminate), never raise.
        self.assertEqual(
            client._next_cursor({"meta": {"pagination": {"next_cursor": "c2"}}}),
            "c2",
        )
        self.assertIsNone(client._next_cursor({"meta": None}))
        self.assertIsNone(client._next_cursor({"meta": {"pagination": None}}))
        self.assertIsNone(client._next_cursor({"meta": {}}))
        self.assertIsNone(client._next_cursor({}))
        self.assertIsNone(client._next_cursor(None))
        self.assertIsNone(client._next_cursor([1, 2]))

    def test_paginate_terminates_on_null_meta_without_raising(self):
        # Regression: a 200 whose envelope carries meta: null crashed cursor
        # extraction with AttributeError, while _collection_rows handled the same
        # page. Pagination must yield the page and stop cleanly instead.
        def fake_urlopen(request, timeout=None):
            return _FakeResponse({"ok": True, "data": [1, 2], "meta": None})

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            pages = list(metagraphed_paginate("/api/v1/subnets"))
            rows = metagraphed_fetch_all("/api/v1/subnets")

        self.assertEqual(len(pages), 1)
        self.assertEqual(rows, [1, 2])

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

    def test_rpc_malformed_non_dict_body_raises(self):
        def fake_urlopen(request, timeout=None):
            return _FakeResponse(["not", "an", "object"])

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            with self.assertRaises(MetagraphedError) as ctx:
                metagraphed_rpc("finney", "system_health")
        self.assertIn("malformed", str(ctx.exception).lower())

    def test_rpc_null_result_returns_none(self):
        def fake_urlopen(request, timeout=None):
            return _FakeResponse({"jsonrpc": "2.0", "id": 1, "result": None})

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            result = metagraphed_rpc("finney", "system_health")
        self.assertIsNone(result)

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

    def test_provider_slug_aliases_the_api_id_key(self):
        # The providers API exposes the slug as `id` (there is no `slug` key), so
        # Provider.slug must alias from `id` instead of silently staying None.
        provider = Provider.from_dict(
            {"id": "macrocosmos", "name": "Macrocosmos", "surface_count": 12}
        )
        self.assertEqual(provider.slug, "macrocosmos")
        self.assertEqual(provider.name, "Macrocosmos")
        self.assertEqual(provider.surface_count, 12)
        self.assertEqual(provider.raw["id"], "macrocosmos")

    def test_provider_explicit_slug_wins_over_alias(self):
        # A direct `slug` (should the API ever send one) takes precedence over the
        # `id` alias; the alias only fills an otherwise-unset field.
        provider = Provider.from_dict({"id": "from-id", "slug": "from-slug"})
        self.assertEqual(provider.slug, "from-slug")

    def test_alias_does_not_leak_to_other_models(self):
        # The alias map is per-model: a Subnet carrying an `id` must not pick it
        # up as a slug (Subnet has no such alias).
        subnet = Subnet.from_dict({"id": "x", "slug": "real-slug"})
        self.assertEqual(subnet.slug, "real-slug")

    def test_client_paginate_follows_next_cursor_with_nested_collection(self):
        # Mirrors README's client.paginate usage: list endpoints nest rows under
        # data[meta.pagination.collection] and follow next_cursor across pages.
        pages = [
            {
                "ok": True,
                "data": {
                    "subnets": [
                        {
                            "netuid": 1,
                            "name": "Apex",
                            "integration_readiness": 40,
                        }
                    ]
                },
                "meta": {
                    "pagination": {
                        "collection": "subnets",
                        "next_cursor": "c2",
                    }
                },
            },
            {
                "ok": True,
                "data": {
                    "subnets": [
                        {
                            "netuid": 7,
                            "name": "Allways",
                            "integration_readiness": 90,
                        }
                    ]
                },
                "meta": {
                    "pagination": {
                        "collection": "subnets",
                        "next_cursor": None,
                    }
                },
            },
        ]
        captured_urls = []
        responses = iter(_FakeResponse(page) for page in pages)

        def fake_urlopen(request, timeout=None):
            captured_urls.append(request.full_url)
            return next(responses)

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            seen = []
            for page in MetagraphedClient().paginate(
                "/api/v1/subnets", query={"limit": 1}
            ):
                seen.extend(page["data"]["subnets"])

        self.assertEqual(
            [(row["netuid"], row["name"], row["integration_readiness"]) for row in seen],
            [(1, "Apex", 40), (7, "Allways", 90)],
        )
        self.assertIn("limit=1", captured_urls[0])
        self.assertIn("cursor=c2", captured_urls[1])

    def test_surfaces_convenience_returns_typed_models(self):
        # Realistic SurfacesArtifact row shape (schemas/components/04-surfaces.schema.json).
        pages = [
            {
                "data": {
                    "surfaces": [
                        {
                            "id": "sn-7-openapi",
                            "netuid": 7,
                            "kind": "openapi",
                            "name": "Allways OpenAPI",
                            "url": "https://api.example.com/openapi.json",
                            "provider": "allways",
                            "auth_required": False,
                            "authority": "official",
                            "public_safe": True,
                            "schema_url": "https://api.example.com/openapi.json",
                        }
                    ]
                },
                "meta": {
                    "pagination": {
                        "collection": "surfaces",
                        "next_cursor": None,
                    }
                },
            }
        ]
        with self._patch_pages(pages):
            surfaces = MetagraphedClient().surfaces(kind="openapi")
        self.assertEqual(len(surfaces), 1)
        surface = surfaces[0]
        self.assertIsInstance(surface, Surface)
        self.assertEqual(surface.id, "sn-7-openapi")
        self.assertEqual(surface.netuid, 7)
        self.assertEqual(surface.kind, "openapi")
        self.assertEqual(surface.name, "Allways OpenAPI")
        self.assertEqual(surface.url, "https://api.example.com/openapi.json")
        self.assertEqual(surface.provider, "allways")
        self.assertIs(surface.auth_required, False)
        self.assertIs(surface.public_safe, True)
        self.assertEqual(surface.schema_url, "https://api.example.com/openapi.json")
        self.assertEqual(surface.raw["authority"], "official")

    def test_endpoints_convenience_returns_typed_models(self):
        # Realistic EndpointResource shape (schemas/api-components.schema.json):
        # the backend exposes `url`, not `base_url`.
        pages = [
            {
                "data": {
                    "endpoints": [
                        {
                            "id": "ep-sn-7-subnet-api",
                            "surface_id": "sn-7-subnet-api",
                            "surface_key": "hk7subnetapi",
                            "netuid": 7,
                            "layer": "subnet",
                            "kind": "subnet-api",
                            "url": "https://api.example.com/v1",
                            "provider": "allways",
                            "operator": "allways",
                            "auth_required": False,
                            "public_safe": True,
                            "classification": "primary",
                            "monitoring_policy": "probe",
                            "monitoring_status": "monitored",
                            "health_source": "probe-derived",
                            "health_stale": False,
                            "last_checked": "2026-07-15T00:00:00.000Z",
                            "last_ok": "2026-07-15T00:00:00.000Z",
                            "status": "ok",
                            "score": 100,
                        }
                    ]
                },
                "meta": {
                    "pagination": {
                        "collection": "endpoints",
                        "next_cursor": None,
                    }
                },
            }
        ]
        with self._patch_pages(pages):
            endpoints = MetagraphedClient().endpoints()
        self.assertEqual(len(endpoints), 1)
        endpoint = endpoints[0]
        self.assertIsInstance(endpoint, Endpoint)
        self.assertEqual(endpoint.surface_id, "sn-7-subnet-api")
        self.assertEqual(endpoint.netuid, 7)
        self.assertEqual(endpoint.kind, "subnet-api")
        self.assertEqual(endpoint.url, "https://api.example.com/v1")
        self.assertEqual(endpoint.provider, "allways")
        self.assertEqual(endpoint.classification, "primary")
        self.assertEqual(endpoint.monitoring_status, "monitored")
        self.assertEqual(endpoint.raw["id"], "ep-sn-7-subnet-api")
        self.assertEqual(endpoint.raw["url"], "https://api.example.com/v1")

    def test_endpoint_from_dict_populates_url_from_endpoint_resource(self):
        endpoint = Endpoint.from_dict(
            {
                "surface_id": "sn-22-docs",
                "netuid": 22,
                "kind": "docs",
                "url": "https://docs.example.com",
                "provider": "desearch",
                "classification": "reference",
                "monitoring_status": "not_monitored",
                "unknown_extra": True,
            }
        )
        self.assertEqual(endpoint.url, "https://docs.example.com")
        self.assertEqual(endpoint.surface_id, "sn-22-docs")
        self.assertEqual(endpoint.kind, "docs")
        self.assertIs(endpoint.raw["unknown_extra"], True)

    def test_agent_catalog_returns_typed_model(self):
        # Realistic AgentCatalogSubnetArtifact data envelope
        # (schemas/api-components.schema.json AgentCatalogSubnetArtifact).
        def fake_urlopen(request, timeout=None):
            self.assertIn("/api/v1/agent-catalog/7", request.full_url)
            return _FakeResponse(
                {
                    "ok": True,
                    "schema_version": 1,
                    "data": {
                        "netuid": 7,
                        "slug": "allways",
                        "name": "AllwaysAI",
                        "subnet_type": "inference",
                        "completeness_score": 82.5,
                        "integration_readiness": 90,
                        "service_count": 1,
                        "services": [
                            {
                                "surface_id": "sn-7-subnet-api",
                                "kind": "subnet-api",
                                "base_url": "https://api.example.com/v1",
                                "auth_required": False,
                            }
                        ],
                    },
                }
            )

        with mock.patch("metagraphed.client._open_request", fake_urlopen):
            catalog = MetagraphedClient().agent_catalog(7)

        self.assertIsInstance(catalog, AgentCatalogSubnet)
        self.assertEqual(catalog.netuid, 7)
        self.assertEqual(catalog.slug, "allways")
        self.assertEqual(catalog.name, "AllwaysAI")
        self.assertEqual(catalog.subnet_type, "inference")
        self.assertEqual(catalog.completeness_score, 82.5)
        self.assertEqual(catalog.integration_readiness, 90)
        self.assertEqual(catalog.service_count, 1)
        self.assertEqual(len(catalog.services), 1)
        self.assertEqual(catalog.services[0]["base_url"], "https://api.example.com/v1")
        self.assertEqual(catalog.services[0]["surface_id"], "sn-7-subnet-api")
        self.assertEqual(catalog.raw["name"], "AllwaysAI")


if __name__ == "__main__":
    unittest.main()
