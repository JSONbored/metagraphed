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
    DEFAULT_USER_AGENT,
    MetagraphedError,
    _MAX_RETRY_AFTER_SECONDS,
    _RETRY_STATUSES,
    _interpolate,
)
from .models import AgentCatalogSubnet, Endpoint, Provider, Subnet, Surface

if TYPE_CHECKING:  # pragma: no cover - type-checking only
    import httpx


def _require_httpx() -> Any:
    try:
        import httpx
    except ImportError as error:  # pragma: no cover - import guard
        raise MetagraphedError(
            "The async client requires httpx. Install it with: "
            "pip install 'metagraphed[async]'"
        ) from error
    return httpx


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
        self._client = httpx.AsyncClient(timeout=timeout)

    async def __aenter__(self) -> "AsyncMetagraphedClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Close the underlying connection pool."""
        await self._client.aclose()

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
        params = (
            {key: value for key, value in query.items() if value is not None}
            if query
            else None
        )
        merged_headers = {
            "Accept": "application/json",
            "User-Agent": DEFAULT_USER_AGENT,
        }
        merged_headers.update(headers or {})

        attempt = 0
        while True:
            try:
                response = await self._client.get(
                    url, params=params, headers=merged_headers
                )
            except self._httpx.HTTPError as error:
                if attempt < self.retries:
                    await asyncio.sleep(self.backoff * (2**attempt))
                    attempt += 1
                    continue
                raise MetagraphedError(f"GET {url} failed: {error}") from error
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
                    f"GET {url} failed: HTTP {response.status_code}"
                    f"{_response_error_detail(response)}",
                    status=response.status_code,
                )
            break

        try:
            return response.json()
        except ValueError as error:
            raise MetagraphedError(
                f"GET {url} returned a non-JSON response"
            ) from error

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
            pagination = (
                page.get("meta", {}).get("pagination")
                if isinstance(page, dict)
                else None
            )
            cursor = (
                pagination.get("next_cursor")
                if isinstance(pagination, dict)
                else None
            )
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
        """Follow pagination and return every item (flattened ``data`` arrays)."""
        items: List[Any] = []
        async for page in self.paginate(
            path, path_params=path_params, query=query, headers=headers
        ):
            data = page.get("data") if isinstance(page, dict) else None
            if isinstance(data, list):
                items.extend(data)
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
        """Call the read-only Subtensor RPC proxy and return the JSON-RPC result."""
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
        merged_headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": DEFAULT_USER_AGENT,
        }
        merged_headers.update(headers or {})

        try:
            response = await self._client.post(
                url, json=payload, headers=merged_headers
            )
        except self._httpx.HTTPError as error:
            raise MetagraphedError(f"RPC {method} failed: {error}") from error
        if response.status_code >= 400:
            raise MetagraphedError(
                f"RPC {method} failed: HTTP {response.status_code}"
                f"{_response_error_detail(response)}",
                status=response.status_code,
            )
        try:
            parsed = response.json()
        except ValueError as error:
            raise MetagraphedError(
                f"RPC {method} returned a non-JSON response"
            ) from error
        rpc_error = parsed.get("error") if isinstance(parsed, dict) else None
        if rpc_error:
            message = (
                rpc_error.get("message") if isinstance(rpc_error, dict) else None
            )
            raise MetagraphedError(f"RPC {method} error: {message or rpc_error}")
        return parsed.get("result") if isinstance(parsed, dict) else None

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
