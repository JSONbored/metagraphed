"""Hermetic tests for the async client (httpx stubbed, no network)."""

import unittest

try:
    import httpx

    _HAS_HTTPX = True
except ImportError:  # pragma: no cover - exercised only without the extra
    _HAS_HTTPX = False

from metagraphed import AsyncMetagraphedClient, MetagraphedError, Subnet


class _FakeAsyncHttp:
    """Stand-in for ``httpx.AsyncClient``: returns queued responses, records calls."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    async def get(self, url, params=None, headers=None):
        self.calls.append(("GET", url, params))
        return self._responses.pop(0)

    async def post(self, url, json=None, headers=None):
        self.calls.append(("POST", url, json))
        return self._responses.pop(0)

    async def aclose(self):
        self.closed = True


@unittest.skipUnless(_HAS_HTTPX, "httpx not installed (metagraphed[async])")
class AsyncClientTest(unittest.IsolatedAsyncioTestCase):
    def _client(self, *responses):
        client = AsyncMetagraphedClient()
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

    async def test_context_manager_closes_pool(self):
        client = self._client(httpx.Response(200, json={"data": []}))
        async with client:
            await client.fetch_all("/api/v1/subnets")
        self.assertTrue(getattr(client._client, "closed", False))


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
