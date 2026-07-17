"""Hermetic tests for the async client (httpx stubbed, no network)."""

import unittest

try:
    import httpx

    _HAS_HTTPX = True
except ImportError:  # pragma: no cover - exercised only without the extra
    _HAS_HTTPX = False

from metagraphed import (
    AgentCatalogSubnet,
    AsyncMetagraphedClient,
    CandidateSurface,
    Endpoint,
    HealthSummary,
    MetagraphedError,
    Provider,
    Subnet,
    SubnetDetail,
    SubnetProfile,
    Surface,
)


class _FakeAsyncHttp:
    """Stand-in for ``httpx.AsyncClient``: returns queued responses, records calls.

    A queued item that is an ``Exception`` is raised instead of returned, which
    lets a test simulate a network failure (``httpx.HTTPError``) on a given call.
    """

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def _next(self):
        item = self._responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    async def get(self, url, params=None, headers=None):
        self.calls.append(("GET", url, params))
        return self._next()

    async def post(self, url, json=None, headers=None):
        self.calls.append(("POST", url, json))
        return self._next()

    async def aclose(self):
        self.closed = True


@unittest.skipUnless(_HAS_HTTPX, "httpx not installed (metagraphed[async])")
class AsyncClientTest(unittest.IsolatedAsyncioTestCase):
    def _client(self, *responses, **kwargs):
        client = AsyncMetagraphedClient(**kwargs)
        client._client = _FakeAsyncHttp(responses)
        return client

    async def test_fetch_interpolates_path_and_returns_envelope(self):
        client = self._client(
            httpx.Response(200, json={"ok": True, "data": {"netuid": 7}})
        )
        out = await client.fetch(
            "/api/v1/subnets/{netuid}", path_params={"netuid": 7}
        )
        self.assertEqual(out["data"]["netuid"], 7)
        self.assertEqual(
            client._client.calls[0][1],
            "https://api.metagraph.sh/api/v1/subnets/7",
        )

    async def test_fetch_drops_none_query_values(self):
        client = self._client(httpx.Response(200, json={"data": []}))
        await client.fetch("/api/v1/subnets", query={"limit": 5, "cursor": None})
        self.assertEqual(client._client.calls[0][2], {"limit": 5})

    async def test_fetch_drops_none_elements_in_list_query_values(self):
        # None inside a list must be dropped — not left for httpx to stringify
        # as "" — and must match the sync client's _query_pairs output.
        from metagraphed.client import _query_pairs

        query = {"kind": ["docs", None, "openapi"]}
        client = self._client(httpx.Response(200, json={"data": []}))
        await client.fetch("/api/v1/surfaces", query=query)
        expected = dict(_query_pairs(query))
        self.assertEqual(expected, {"kind": ["docs", "openapi"]})
        self.assertEqual(client._client.calls[0][2], expected)
        self.assertNotIn(None, client._client.calls[0][2]["kind"])
        self.assertNotIn("", client._client.calls[0][2]["kind"])

    async def test_fetch_all_collects_nested_collection_following_cursor(self):
        # List endpoints nest rows under data[meta.pagination.collection].
        page1 = httpx.Response(
            200,
            json={
                "data": {"subnets": [{"netuid": 1}]},
                "meta": {"pagination": {"collection": "subnets", "next_cursor": "c2"}},
            },
        )
        page2 = httpx.Response(
            200,
            json={
                "data": {"subnets": [{"netuid": 2}]},
                "meta": {"pagination": {"collection": "subnets", "next_cursor": None}},
            },
        )
        client = self._client(page1, page2)
        items = await client.fetch_all("/api/v1/subnets")
        self.assertEqual([item["netuid"] for item in items], [1, 2])

    async def test_subnets_returns_typed_models(self):
        client = self._client(
            httpx.Response(
                200, json={"data": [{"netuid": 7, "name": "Allways"}], "meta": {}}
            )
        )
        subnets = await client.subnets()
        self.assertIsInstance(subnets[0], Subnet)
        self.assertEqual(subnets[0].netuid, 7)
        self.assertEqual(subnets[0].name, "Allways")
        self.assertEqual(subnets[0].raw["name"], "Allways")

    async def test_subnets_completeness_score_absent_from_index(self):
        # Mirrors the sync contract: index rows set integration_readiness and
        # leave completeness_score unset (None).
        client = self._client(
            httpx.Response(
                200,
                json={
                    "data": {
                        "subnets": [
                            {
                                "netuid": 7,
                                "name": "Allways",
                                "integration_readiness": 72,
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
            )
        )
        subnets = await client.subnets()
        self.assertEqual(len(subnets), 1)
        self.assertEqual(subnets[0].integration_readiness, 72)
        self.assertIsNone(subnets[0].completeness_score)
        self.assertNotIn("completeness_score", subnets[0].raw)

    async def test_get_subnet_returns_typed_detail(self):
        client = self._client(
            httpx.Response(
                200,
                json={
                    "ok": True,
                    "data": {
                        "subnet": {
                            "netuid": 7,
                            "name": "Allways",
                            "slug": "allways",
                            "coverage_level": "verified",
                        },
                        "surfaces": [{"id": "sn-7-openapi"}],
                        "candidate_surfaces": [],
                        "gaps": {"missing_kinds": ["docs"]},
                    },
                },
            )
        )
        detail = await client.get_subnet(7)
        self.assertIsInstance(detail, SubnetDetail)
        self.assertEqual(detail.netuid, 7)
        self.assertEqual(detail.slug, "allways")
        self.assertEqual(detail.coverage_level, "verified")
        self.assertTrue(client._client.calls[0][1].endswith("/api/v1/subnets/7"))

    async def test_paginate_follows_next_cursor_with_nested_collection(self):
        # Mirrors README async usage of paginate via fetch_all / typed helpers:
        # nested collection rows + cursor continuation.
        page1 = httpx.Response(
            200,
            json={
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
        )
        page2 = httpx.Response(
            200,
            json={
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
        )
        client = self._client(page1, page2)
        seen = []
        async for page in client.paginate("/api/v1/subnets", query={"limit": 1}):
            seen.extend(page["data"]["subnets"])

        self.assertEqual(
            [(row["netuid"], row["name"], row["integration_readiness"]) for row in seen],
            [(1, "Apex", 40), (7, "Allways", 90)],
        )
        self.assertEqual(client._client.calls[0][2], {"limit": 1})
        self.assertEqual(client._client.calls[1][2]["cursor"], "c2")

    async def test_surfaces_returns_typed_models(self):
        client = self._client(
            httpx.Response(
                200,
                json={
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
                },
            )
        )
        surfaces = await client.surfaces(kind="openapi")
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

    async def test_providers_returns_typed_models(self):
        # The providers API exposes the slug as `id` (Provider aliases id -> slug).
        client = self._client(
            httpx.Response(
                200,
                json={
                    "data": {
                        "providers": [
                            {
                                "id": "macrocosmos",
                                "name": "Macrocosmos",
                                "authority": "official",
                                "surface_count": 12,
                            }
                        ]
                    },
                    "meta": {
                        "pagination": {
                            "collection": "providers",
                            "next_cursor": None,
                        }
                    },
                },
            )
        )
        providers = await client.providers(authority="official")
        self.assertEqual(len(providers), 1)
        provider = providers[0]
        self.assertIsInstance(provider, Provider)
        self.assertEqual(provider.slug, "macrocosmos")
        self.assertEqual(provider.name, "Macrocosmos")
        self.assertEqual(provider.authority, "official")
        self.assertEqual(provider.surface_count, 12)
        self.assertEqual(provider.raw["id"], "macrocosmos")
        # Query kwargs reach fetch_all's request query.
        self.assertEqual(client._client.calls[0][2], {"authority": "official"})

    async def test_endpoints_returns_typed_models(self):
        client = self._client(
            httpx.Response(
                200,
                json={
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
                },
            )
        )
        endpoints = await client.endpoints()
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
        self.assertFalse(hasattr(endpoint, "base_url"))

    async def test_get_provider_returns_typed_provider(self):
        client = self._client(
            httpx.Response(
                200,
                json={
                    "ok": True,
                    "data": {
                        "provider": {
                            "id": "macrocosmos",
                            "name": "Macrocosmos",
                            "authority": "official",
                            "surface_count": 12,
                        }
                    },
                },
            )
        )
        provider = await client.get_provider("macrocosmos")
        self.assertIsInstance(provider, Provider)
        self.assertEqual(provider.slug, "macrocosmos")
        self.assertEqual(provider.surface_count, 12)
        self.assertTrue(
            client._client.calls[0][1].endswith("/api/v1/providers/macrocosmos")
        )

    async def test_candidates_returns_typed_models(self):
        client = self._client(
            httpx.Response(
                200,
                json={
                    "data": {
                        "candidates": [
                            {
                                "id": "candidate-7-openapi",
                                "netuid": 7,
                                "kind": "openapi",
                                "state": "schema-valid",
                                "confidence": "high",
                            }
                        ]
                    },
                    "meta": {
                        "pagination": {
                            "collection": "candidates",
                            "next_cursor": None,
                        }
                    },
                },
            )
        )
        candidates = await client.candidates(confidence="high")
        self.assertIsInstance(candidates[0], CandidateSurface)
        self.assertEqual(candidates[0].id, "candidate-7-openapi")
        self.assertEqual(client._client.calls[0][2], {"confidence": "high"})

    async def test_profiles_returns_typed_models(self):
        client = self._client(
            httpx.Response(
                200,
                json={
                    "data": {
                        "profiles": [
                            {
                                "netuid": 7,
                                "slug": "allways",
                                "name": "Allways",
                                "profile_level": "operational",
                                "completeness_score": 82,
                            }
                        ]
                    },
                    "meta": {
                        "pagination": {
                            "collection": "profiles",
                            "next_cursor": None,
                        }
                    },
                },
            )
        )
        profiles = await client.profiles(profile_level="operational")
        self.assertIsInstance(profiles[0], SubnetProfile)
        self.assertEqual(profiles[0].completeness_score, 82)
        self.assertEqual(
            client._client.calls[0][2], {"profile_level": "operational"}
        )

    async def test_health_returns_typed_summary(self):
        client = self._client(
            httpx.Response(
                200,
                json={
                    "ok": True,
                    "data": {
                        "schema_version": 1,
                        "global": {"status": "ok", "surface_count": 4},
                        "subnets": [{"netuid": 7, "status": "ok"}],
                        "health_source": "probe-derived",
                    },
                },
            )
        )
        health = await client.health()
        self.assertIsInstance(health, HealthSummary)
        self.assertEqual(health.global_["status"], "ok")
        self.assertEqual(health.subnets[0]["netuid"], 7)
        self.assertTrue(client._client.calls[0][1].endswith("/api/v1/health"))

    async def test_agent_catalog_returns_typed_model(self):
        client = self._client(
            httpx.Response(
                200,
                json={
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
                },
            )
        )
        catalog = await client.agent_catalog(7)
        self.assertIsInstance(catalog, AgentCatalogSubnet)
        self.assertEqual(catalog.netuid, 7)
        self.assertEqual(catalog.slug, "allways")
        self.assertEqual(catalog.name, "AllwaysAI")
        self.assertEqual(catalog.subnet_type, "inference")
        self.assertEqual(catalog.completeness_score, 82.5)
        self.assertEqual(catalog.integration_readiness, 90)
        self.assertEqual(catalog.service_count, 1)
        self.assertEqual(catalog.services[0]["base_url"], "https://api.example.com/v1")
        self.assertEqual(
            client._client.calls[0][1],
            "https://api.metagraph.sh/api/v1/agent-catalog/7",
        )

    async def test_http_error_raises_with_status_and_message(self):
        client = self._client(
            httpx.Response(
                404, json={"error": {"code": "not_found", "message": "nope"}}
            )
        )
        with self.assertRaises(MetagraphedError) as ctx:
            await client.fetch(
                "/api/v1/subnets/{netuid}", path_params={"netuid": 999}
            )
        self.assertEqual(ctx.exception.status, 404)
        self.assertIn("nope", str(ctx.exception))

    async def test_rpc_posts_and_returns_result(self):
        client = self._client(
            httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": "0xabc"})
        )
        out = await client.rpc("finney", "chain_getBlockHash", [0])
        self.assertEqual(out, "0xabc")
        method, url, body = client._client.calls[0]
        self.assertEqual(method, "POST")
        self.assertTrue(url.endswith("/rpc/v1/finney"))
        self.assertEqual(body["method"], "chain_getBlockHash")

    async def test_rpc_retries_transient_error_then_succeeds(self):
        client = self._client(
            httpx.Response(503, text="busy"),
            httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": "0xok"}),
            retries=1,
            backoff=0,
        )
        out = await client.rpc("finney", "chain_getBlockHash", [0])
        self.assertEqual(out, "0xok")
        self.assertEqual(len(client._client.calls), 2)
        self.assertTrue(all(call[0] == "POST" for call in client._client.calls))

    async def test_rpc_retries_network_error_then_succeeds(self):
        client = self._client(
            httpx.ConnectError("connection reset"),
            httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": "0xok"}),
            retries=1,
            backoff=0,
        )
        out = await client.rpc("finney", "chain_getBlockHash", [0])
        self.assertEqual(out, "0xok")
        self.assertEqual(len(client._client.calls), 2)

    async def test_rpc_retries_exhausted_raises_after_configured_count(self):
        client = self._client(
            httpx.Response(503, text="busy"),
            httpx.Response(503, text="busy"),
            httpx.Response(503, text="busy"),
            retries=2,
            backoff=0,
        )
        with self.assertRaises(MetagraphedError) as ctx:
            await client.rpc("finney", "system_health")
        # Initial attempt + 2 retries, then it gives up.
        self.assertEqual(len(client._client.calls), 3)
        self.assertEqual(ctx.exception.status, 503)

    async def test_context_manager_closes_pool(self):
        client = self._client(httpx.Response(200, json={"data": []}))
        async with client:
            await client.fetch_all("/api/v1/subnets")
        self.assertTrue(getattr(client._client, "closed", False))

    async def test_cross_origin_redirect_strips_custom_headers(self):
        # Mirrors test_client.ClientTest.test_cross_origin_redirect_strips_custom_headers:
        # follow a cross-origin redirect and keep only the allowlisted headers
        # (Accept / User-Agent) — not Authorization / X-Api-Key / Cookie.
        from metagraphed import aio as aio_mod

        hops = []

        def handler(request: httpx.Request) -> httpx.Response:
            hops.append(request)
            if request.url.host == "api.example.test":
                return httpx.Response(
                    302,
                    headers={
                        "Location": "https://attacker.example.test/api/v1/subnets/7"
                    },
                )
            return httpx.Response(200, json={"ok": True, "data": {"netuid": 7}})

        client = AsyncMetagraphedClient(base_url="https://api.example.test")
        await client.aclose()
        client._client = aio_mod._cross_origin_safe_async_client(
            httpx, timeout=30.0, transport=httpx.MockTransport(handler)
        )
        try:
            self.assertTrue(client._client.follow_redirects)
            out = await client.fetch(
                "/api/v1/subnets/7",
                headers={
                    "Authorization": "Bearer SECRET",
                    "X-Api-Key": "SECRET",
                    "Cookie": "session=SECRET",
                },
            )
            self.assertEqual(out["data"]["netuid"], 7)
            self.assertEqual(len(hops), 2)

            first, second = hops
            self.assertEqual(first.url.host, "api.example.test")
            self.assertEqual(first.headers["Authorization"], "Bearer SECRET")
            self.assertEqual(first.headers["X-Api-Key"], "SECRET")
            self.assertEqual(first.headers["Cookie"], "session=SECRET")

            self.assertEqual(second.url.host, "attacker.example.test")
            self.assertEqual(second.headers.get("Accept"), "application/json")
            self.assertIsNotNone(second.headers.get("User-Agent"))
            self.assertNotIn("authorization", second.headers)
            self.assertNotIn("x-api-key", second.headers)
            self.assertNotIn("cookie", second.headers)
        finally:
            await client.aclose()


class AsyncImportGuardTest(unittest.TestCase):
    @unittest.skipIf(
        _HAS_HTTPX, "httpx installed; the missing-httpx path can't be exercised"
    )
    def test_missing_httpx_raises_a_helpful_error(self):
        with self.assertRaises(MetagraphedError) as ctx:
            AsyncMetagraphedClient()
        self.assertIn("metagraphed[async]", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
