"""Optional async client for metagraphed (httpx) — parity with the sync client.

Install with ``pip install 'metagraphed[async]'``. ``httpx`` is imported lazily,
so the base package stays dependency-free; constructing
:class:`AsyncMetagraphedClient` without httpx installed raises a clear
:class:`~metagraphed.MetagraphedError` pointing at the extra.

The async client reuses one connection pool, which is the whole point: fetching
many subnets concurrently (``asyncio.gather``) no longer needs hand-rolled
threads. Use it as an async context manager, or call :meth:`aclose` when done.
"""

from __future__ import annotations

import asyncio
import json
import urllib.parse
from typing import TYPE_CHECKING, Any, AsyncIterator, List, Mapping, Optional, Sequence

from .client import (
    DEFAULT_BASE_URL,
    MetagraphedError,
    _MAX_RETRY_AFTER_SECONDS,
    _RETRY_STATUSES,
    _collection_rows,
    _default_headers,
    _interpolate,
    _jsonrpc_result,
    _next_cursor,
    _query_pairs,
    _url_origin,
)
from .models import AgentCatalogSubnet, Endpoint, Provider, Subnet, Surface

if TYPE_CHECKING:  # pragma: no cover - type-checking only
    import httpx


# Parity with ``client._CrossOriginSafeRedirectHandler``: only these survive an
# origin change. Compared case-insensitively (httpx normalizes header names).
_CROSS_ORIGIN_HEADER_ALLOWLIST = frozenset({"accept", "user-agent"})


def _require_httpx() -> Any:
    try:
        import httpx
    except ImportError as error:  # pragma: no cover - import guard
        raise MetagraphedError(
            "The async client requires httpx. Install it with: "
            "pip install 'metagraphed[async]'"
        ) from error
    return httpx


def _cross_origin_safe_async_client(
    httpx: Any, *, timeout: float, **client_kwargs: Any
) -> "httpx.AsyncClient":
    """``AsyncClient`` that follows redirects like the sync client — including
    stripping non-allowlisted headers on a cross-origin hop.

    httpx's built-in ``follow_redirects=True`` only drops ``Authorization``
    (and rebuilds ``Cookie``) across origins, so custom headers like
    ``X-Api-Key`` would still leak. Overriding ``_redirect_headers`` matches
    ``_CrossOriginSafeRedirectHandler``'s allowlist safety property.
    """

    class _CrossOriginSafeAsyncClient(httpx.AsyncClient):
        def _redirect_headers(self, request: Any, url: Any, method: str) -> Any:
            headers = super()._redirect_headers(request, url, method)
            if _url_origin(str(request.url)) != _url_origin(str(url)):
                for key in list(headers):
                    if key.lower() not in _CROSS_ORIGIN_HEADER_ALLOWLIST:
                        del headers[key]
            return headers

    return _CrossOriginSafeAsyncClient(
        timeout=timeout, follow_redirects=True, **client_kwargs
    )


def _retry_after_seconds(
    response: "httpx.Response", attempt: int, backoff: float
) -> float:
    """A numeric ``Retry-After`` (capped at 60s) if present, else exponential
    backoff. Never raises."""
    retry_after = response.headers.get("Retry-After")
    if retry_after:
        try:
            return min(_MAX_RETRY_AFTER_SECONDS, max(0.0, float(int(retry_after))))
        except (OverflowError, TypeError, ValueError):
            pass
    return backoff * (2**attempt)


def _response_error_detail(response: "httpx.Response") -> str:
    """Best-effort extraction of the API's ``{ error: { code, message } }``
    envelope from a failed response. Never raises."""
    try:
        raw = response.text.strip()
    except Exception:
        return ""
    if not raw:
        return ""
    try:
        parsed = json.loads(raw)
    except ValueError:
        return f": {raw[:200]}"
    envelope = parsed.get("error") if isinstance(parsed, dict) else None
    if isinstance(envelope, dict) and envelope.get("message"):
        code = envelope.get("code")
        return f": {str(code) + ' — ' if code else ''}{envelope['message']}"
    return f": {raw[:200]}"


class AsyncMetagraphedClient:
    """Async metagraphed client backed by a shared ``httpx.AsyncClient``."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = 30.0,
        retries: int = 0,
        backoff: float = 0.5,
    ) -> None:
        httpx = _require_httpx()
        self.base_url = base_url
        self.timeout = timeout
        self.retries = retries
        self.backoff = backoff
        self._httpx = httpx
        self._client = _cross_origin_safe_async_client(httpx, timeout=timeout)

    async def __aenter__(self) -> "AsyncMetagraphedClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Close the underlying connection pool."""
        await self._client.aclose()

    async def _send_json(self, send: Any, *, label: str) -> Any:
        """Perform a request via ``send`` (an async thunk returning a response),
        retrying transient failures, and return the parsed JSON body.

        Retries HTTP 429/5xx and network errors up to ``self.retries`` times with
        exponential ``self.backoff`` seconds, honoring a numeric ``Retry-After``
        capped at 60 seconds. ``label`` (e.g. ``"GET <url>"`` or ``"RPC
        <method>"``) prefixes error messages. Raises :class:`MetagraphedError`
        once retries are exhausted or if the body is not JSON.
        """
        attempt = 0
        while True:
            try:
                response = await send()
            except self._httpx.HTTPError as error:
                if attempt < self.retries:
                    await asyncio.sleep(self.backoff * (2**attempt))
                    attempt += 1
                    continue
                raise MetagraphedError(f"{label} failed: {error}") from error
            if response.status_code >= 400:
                if (
                    attempt < self.retries
                    and response.status_code in _RETRY_STATUSES
                ):
                    await asyncio.sleep(
                        _retry_after_seconds(response, attempt, self.backoff)
                    )
                    attempt += 1
                    continue
                raise MetagraphedError(
                    f"{label} failed: HTTP {response.status_code}"
                    f"{_response_error_detail(response)}",
                    status=response.status_code,
                )
            break

        try:
            return response.json()
        except ValueError as error:
            raise MetagraphedError(
                f"{label} returned a non-JSON response"
            ) from error

    async def fetch(
        self,
        path: str,
        *,
        path_params: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> Any:
        """GET ``path`` and return the parsed ``{ ok, data, meta }`` envelope.

        Retries idempotent GETs on transient errors (HTTP 429/5xx and network
        failures) when this client was created with ``retries`` > 0, honoring a
        numeric ``Retry-After`` capped at 60 seconds.
        """
        url = self.base_url.rstrip("/") + _interpolate(path, path_params)
        # Same normalization as the sync client (`_query_pairs`): drop top-level
        # and in-list ``None``, coerce bools — so both clients emit identical
        # query strings for the same input.
        params = dict(_query_pairs(query)) if query else None
        merged_headers = _default_headers(headers)
        return await self._send_json(
            lambda: self._client.get(url, params=params, headers=merged_headers),
            label=f"GET {url}",
        )

    async def paginate(
        self,
        path: str,
        *,
        path_params: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> AsyncIterator[Any]:
        """Yield each page's envelope, following ``meta.pagination.next_cursor``."""
        base_query = dict(query or {})
        cursor = base_query.get("cursor")
        while True:
            page_query = dict(base_query)
            if cursor is not None:
                page_query["cursor"] = cursor
            page = await self.fetch(
                path, path_params=path_params, query=page_query, headers=headers
            )
            yield page
            cursor = _next_cursor(page)
            if cursor is None:
                return

    async def fetch_all(
        self,
        path: str,
        *,
        path_params: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> List[Any]:
        """Follow pagination and return every row across all pages (the nested
        ``data`` collection; see :func:`~metagraphed.client._collection_rows`)."""
        items: List[Any] = []
        async for page in self.paginate(
            path, path_params=path_params, query=query, headers=headers
        ):
            items.extend(_collection_rows(page))
        return items

    async def rpc(
        self,
        network: str,
        method: str,
        params: Optional[Sequence[Any]] = None,
        *,
        headers: Optional[Mapping[str, str]] = None,
        request_id: Any = 1,
    ) -> Any:
        """Call the read-only Subtensor RPC proxy and return the JSON-RPC result.

        Honors this client's ``retries`` + ``backoff``: the proxy is a read-only
        Subtensor read, so RPC reads are retried on transient errors (HTTP
        429/5xx and network failures) exactly like GETs, honoring a numeric
        ``Retry-After`` capped at 60 seconds.
        """
        url = (
            self.base_url.rstrip("/")
            + "/rpc/v1/"
            + urllib.parse.quote(str(network), safe="")
        )
        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": list(params or []),
        }
        merged_headers = _default_headers(headers, json_body=True)
        parsed = await self._send_json(
            lambda: self._client.post(url, json=payload, headers=merged_headers),
            label=f"RPC {method}",
        )
        return _jsonrpc_result(parsed, method)

    # -- typed convenience methods (raw-dict path stays via fetch/fetch_all) --

    async def subnets(self, **query: Any) -> List[Subnet]:
        return Subnet.list_from(
            await self.fetch_all("/api/v1/subnets", query=query or None)
        )

    async def surfaces(self, **query: Any) -> List[Surface]:
        return Surface.list_from(
            await self.fetch_all("/api/v1/surfaces", query=query or None)
        )

    async def endpoints(self, **query: Any) -> List[Endpoint]:
        return Endpoint.list_from(
            await self.fetch_all("/api/v1/endpoints", query=query or None)
        )

    async def providers(self, **query: Any) -> List[Provider]:
        return Provider.list_from(
            await self.fetch_all("/api/v1/providers", query=query or None)
        )

    async def agent_catalog(self, netuid: Any) -> AgentCatalogSubnet:
        envelope = await self.fetch(
            "/api/v1/agent-catalog/{netuid}", path_params={"netuid": netuid}
        )
        data = envelope.get("data") if isinstance(envelope, dict) else None
        return AgentCatalogSubnet.from_dict(data)
