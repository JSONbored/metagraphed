"""Thin Python client for the metagraphed API (https://api.metagraph.sh).

Dependency-free (stdlib ``urllib`` only). Mirrors the generated TypeScript
client: one generic GET helper over the uniform, read-only API surface,
returning the parsed ``{ ok, schema_version, data, meta }`` envelope as a dict.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from importlib.metadata import PackageNotFoundError, version as _package_version
from typing import Any, Iterator, List, Mapping, Optional, Sequence, Tuple

from .models import (
    AgentCatalogSubnet,
    CandidateSurface,
    Endpoint,
    HealthSummary,
    Provider,
    Subnet,
    SubnetDetail,
    SubnetProfile,
    Surface,
)

# Single source of truth = the package metadata (pyproject.toml `version`, which
# release-please bumps); read it at runtime so the User-Agent can never disagree
# with the published wheel. Falls back when running uninstalled from source.
try:
    __version__ = _package_version("metagraphed")
except PackageNotFoundError:
    __version__ = "0.0.0+local"

DEFAULT_BASE_URL = "https://api.metagraph.sh"
# Transient HTTP statuses worth retrying for idempotent GETs (opt-in via the
# ``retries`` argument). 429/503 may carry a Retry-After header we honor.
_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
# Cap server-supplied retry delays so a malicious Retry-After cannot tie up
# callers that opt into retries for an unbounded amount of time.
_MAX_RETRY_AFTER_SECONDS = 60.0
# A descriptive User-Agent is required: api.metagraph.sh sits behind a Cloudflare
# managed bot rule that returns HTTP 403 for stdlib urllib's default
# "Python-urllib/<ver>" UA. Callers may override it via the ``headers`` argument.
DEFAULT_USER_AGENT = (
    f"metagraphed-python/{__version__} (+https://github.com/JSONbored/metagraphed)"
)
_PATH_PARAM = re.compile(r"\{([^{}]+)\}")


def _url_origin(url: str) -> Tuple[str, str, Optional[int]]:
    parsed = urllib.parse.urlsplit(url)
    port = parsed.port
    if port is None and parsed.scheme == "http":
        port = 80
    elif port is None and parsed.scheme == "https":
        port = 443
    return (parsed.scheme.lower(), (parsed.hostname or "").lower(), port)


class _CrossOriginSafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Redirect handler that does not forward custom headers cross-origin."""

    _CROSS_ORIGIN_HEADER_ALLOWLIST = frozenset({"Accept", "User-agent"})

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is None:
            return None
        if _url_origin(req.full_url) != _url_origin(newurl):
            for key in list(redirected.headers):
                if key not in self._CROSS_ORIGIN_HEADER_ALLOWLIST:
                    redirected.remove_header(key)
            for key in list(redirected.unredirected_hdrs):
                if key not in self._CROSS_ORIGIN_HEADER_ALLOWLIST:
                    redirected.remove_header(key)
        return redirected


def _open_request(request: urllib.request.Request, timeout: float):
    opener = urllib.request.build_opener(_CrossOriginSafeRedirectHandler())
    return opener.open(request, timeout=timeout)


class MetagraphedError(Exception):
    """Raised on a network failure or a non-2xx HTTP response."""

    def __init__(self, message: str, *, status: Optional[int] = None,
                 code: Optional[str] = None, envelope: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.envelope = envelope


def _interpolate(path: str, path_params: Optional[Mapping[str, Any]]) -> str:
    params = path_params or {}

    def repl(match: "re.Match[str]") -> str:
        name = match.group(1)
        if name not in params or params[name] is None:
            raise MetagraphedError(f"Missing path parameter: {name}")
        return urllib.parse.quote(str(params[name]), safe="")

    return _PATH_PARAM.sub(repl, path)


def _default_headers(
    headers: Optional[Mapping[str, str]], *, json_body: bool = False
) -> dict:
    """Metagraphed's default headers, overridable by ``headers`` (which wins, so
    a caller can replace the User-Agent). ``json_body`` adds Content-Type."""
    merged = {"Accept": "application/json", "User-Agent": DEFAULT_USER_AGENT}
    if json_body:
        merged["Content-Type"] = "application/json"
    merged.update(headers or {})
    return merged


def _build_request(
    url: str,
    *,
    method: str,
    data: Optional[bytes] = None,
    headers: Optional[Mapping[str, str]] = None,
) -> urllib.request.Request:
    """A urllib Request with default headers applied; ``data`` implies a POST body."""
    request = urllib.request.Request(url, data=data, method=method)
    for key, value in _default_headers(headers, json_body=data is not None).items():
        request.add_header(key, value)
    return request


def _request_json(
    request: urllib.request.Request,
    *,
    timeout: float,
    retries: int,
    backoff: float,
    label: str,
) -> Any:
    """Open ``request`` and return its parsed JSON body, retrying transient
    failures.

    Retries HTTP 429/5xx and network errors up to ``retries`` times with
    exponential ``backoff`` seconds, honoring a numeric ``Retry-After`` (capped
    at 60s). ``label`` (e.g. ``"GET <url>"`` or ``"RPC <method>"``) prefixes
    error messages. Raises :class:`MetagraphedError` once retries are exhausted
    or if the body is not JSON.
    """
    attempt = 0
    while True:
        try:
            with _open_request(request, timeout=timeout) as response:
                body = response.read().decode("utf-8")
            break
        except urllib.error.HTTPError as error:
            if attempt < retries and error.code in _RETRY_STATUSES:
                time.sleep(_retry_delay(error, attempt, backoff))
                attempt += 1
                continue
            detail, envelope = _error_detail(error)
            raise MetagraphedError(
                f"{label} failed: HTTP {error.code}{detail}",
                status=error.code, code=_catalog_error_code(envelope), envelope=envelope,
            ) from error
        except urllib.error.URLError as error:
            if attempt < retries:
                time.sleep(backoff * (2**attempt))
                attempt += 1
                continue
            raise MetagraphedError(f"{label} failed: {error.reason}") from error

    try:
        return json.loads(body)
    except ValueError as error:
        raise MetagraphedError(f"{label} returned a non-JSON response") from error


def _jsonrpc_result(parsed: Any, method: str) -> Any:
    """Unwrap a JSON-RPC envelope: return its ``result``, or raise its ``error``."""
    if not isinstance(parsed, dict):
        raise MetagraphedError(
            f"RPC {method} returned a malformed response (expected a JSON object)"
        )
    rpc_error = parsed.get("error")
    if rpc_error:
        message = rpc_error.get("message") if isinstance(rpc_error, dict) else None
        raise MetagraphedError(f"RPC {method} error: {message or rpc_error}")
    return parsed.get("result")


def _query_pairs(query: Mapping[str, Any]) -> List[Tuple[str, Any]]:
    """Normalize a query mapping into ``urlencode``-ready ``(key, value)`` pairs.

    Drops ``None`` values (including ``None`` elements inside list/tuple values)
    and coerces Python ``bool`` to the lowercase ``"true"``/``"false"`` the API
    expects. ``str(True)`` would otherwise send ``"True"``, which the API
    compares ``=== "true"`` and silently ignores — so a boolean filter such as
    ``validator_permit=True`` would be dropped and return unfiltered results
    (diverging from both the async/httpx client and the TypeScript client).
    Booleans nested in a sequence value — expanded by ``doseq=True`` — are
    coerced element-wise so list-valued filters normalize too. Filtering
    ``None`` out of sequences (not stringifying them as ``"None"`` or ``""``)
    keeps the sync and async clients on the same wire form.
    """

    def coerce(value: Any) -> Any:
        # ``bool`` is a subclass of ``int``, so it must be handled before any
        # numeric branch; here it maps straight to the API's wire form.
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, (list, tuple)):
            return [coerce(item) for item in value if item is not None]
        return value

    return [
        (key, coerce(value)) for key, value in query.items() if value is not None
    ]


def metagraphed_fetch(
    path: str,
    *,
    base_url: str = DEFAULT_BASE_URL,
    path_params: Optional[Mapping[str, Any]] = None,
    query: Optional[Mapping[str, Any]] = None,
    headers: Optional[Mapping[str, str]] = None,
    timeout: float = 30.0,
    retries: int = 0,
    backoff: float = 0.5,
) -> Any:
    """GET ``path`` against metagraphed and return the parsed JSON envelope.

    ``path`` may contain ``{name}`` segments filled from ``path_params``.
    ``query`` values that are ``None`` are dropped. Raises
    :class:`MetagraphedError` on a network failure or a non-2xx response.

    Set ``retries`` > 0 to retry idempotent GETs on transient errors (HTTP
    429/5xx and network failures) with exponential ``backoff`` seconds, honoring
    a numeric ``Retry-After`` header capped at 60 seconds. Retries are opt-in
    (default 0).
    """
    url = base_url.rstrip("/") + _interpolate(path, path_params)
    if query:
        pairs = _query_pairs(query)
        if pairs:
            url += "?" + urllib.parse.urlencode(pairs, doseq=True)

    return _request_json(
        _build_request(url, method="GET", headers=_catalog_headers(query, headers)),
        timeout=timeout,
        retries=0 if query and query.get("page_snapshot") is not None else retries,
        backoff=backoff,
        label=f"GET {url}",
    )


def _retry_delay(
    error: "urllib.error.HTTPError", attempt: int, backoff: float
) -> float:
    """Seconds to wait before a retry: a numeric Retry-After if present, else
    exponential backoff. Never raises."""
    try:
        retry_after = error.headers.get("Retry-After")
    except Exception:
        retry_after = None
    if retry_after:
        try:
            return min(_MAX_RETRY_AFTER_SECONDS, max(0.0, float(int(retry_after))))
        except (OverflowError, TypeError, ValueError):
            pass
    return backoff * (2**attempt)


def _catalog_error_code(envelope: Any) -> Optional[str]:
    if not isinstance(envelope, dict):
        return None
    meta = envelope.get("meta")
    paging = meta.get("catalog_paging") if isinstance(meta, dict) else None
    reason = paging.get("reason") if isinstance(paging, dict) else None
    codes = {"catalog_changed": "catalog_restart_required",
             "catalog_budget_exceeded": "catalog_budget_exceeded",
             "catalog_unavailable": "artifact_unavailable"}
    error = envelope.get("error")
    return (codes.get(reason) if isinstance(reason, str) else None) or (error.get("code") if isinstance(error, dict) else None)


def _catalog_headers(query: Any, headers: Optional[Mapping[str, str]]) -> Any:
    if not query or query.get("page_snapshot") is None:
        return headers
    result = {key: value for key, value in (headers or {}).items()
              if key.lower() not in {"if-none-match", "if-modified-since", "cache-control"}}
    result["Cache-Control"] = "no-store"
    return result


def _parse_error_detail(raw: str) -> Tuple[str, Any]:
    raw = raw.strip()
    if not raw:
        return "", None
    try:
        parsed = json.loads(raw)
    except ValueError:
        return f": {raw[:200]}", None
    error = parsed.get("error") if isinstance(parsed, dict) else None
    if isinstance(error, dict) and error.get("message"):
        code = error.get("code")
        return f": {str(code) + ' — ' if code else ''}{error['message']}", parsed
    return f": {raw[:200]}", parsed


def _error_detail(error: "urllib.error.HTTPError") -> Tuple[str, Any]:
    """Read an HTTP failure once, retaining its typed envelope and safe detail."""
    try:
        return _parse_error_detail(error.read().decode("utf-8", "replace"))
    except Exception:
        return "", None


def _next_catalog_cursor(page: Any, query: dict, state: dict) -> Any:
    """Validate checked pages before exposing them; legacy/keyset behavior stays intact."""
    if query.get("page_snapshot") is None:
        return _next_cursor(page)
    def fail():
        raise MetagraphedError(
            "Catalog page could not be verified. Restart results from the first page.",
            status=409, code="catalog_restart_required")
    meta = page.get("meta") if isinstance(page, dict) else None
    p = meta.get("pagination") if isinstance(meta, dict) else None
    if not isinstance(p, dict):
        return fail()
    data = page.get("data")
    collection = p.get("collection")
    rows = data.get(collection) if isinstance(data, dict) and isinstance(collection, str) else None
    snapshot = p.get("snapshot")
    cursor = query.get("cursor", 0)
    if isinstance(cursor, str) and re.fullmatch(r"[0-9]+", cursor):
        cursor = int(cursor)
    total = p.get("total")
    if (not isinstance(rows, list) or not isinstance(snapshot, str)
            or re.fullmatch(r"v1[.][0-9a-f]{64}", snapshot) is None
            or query["page_snapshot"] not in ("start", snapshot)
            or type(cursor) is not int or not 0 <= cursor <= 9007199254740991
            or (query["page_snapshot"] == "start" and cursor != 0)
            or type(p.get("cursor")) is not int or p["cursor"] != cursor
            or type(p.get("returned")) is not int or p["returned"] != len(rows)
            or type(total) is not int or not 0 <= total <= 9007199254740991
            or ("total" in state and state["total"] != total)
            or ("collection" in state and state["collection"] != collection)):
        return fail()
    end = cursor + len(rows)
    next_cursor = p.get("next_cursor")
    if (total < end or "next_cursor" not in p
            or (next_cursor is None and end != total)
            or (next_cursor is not None and (not rows or type(next_cursor) is not int
                                             or next_cursor != end or end >= total))):
        return fail()
    query["page_snapshot"] = snapshot
    state.update(total=total, collection=collection)
    return next_cursor


def _next_cursor(page: Any) -> Optional[Any]:
    """Return a list page's ``meta.pagination.next_cursor``, or ``None``.

    Defensive at every level (mirrors :func:`_collection_rows`): a non-dict page,
    a null/absent ``meta``, or a null/absent ``pagination`` all yield ``None`` so
    pagination terminates cleanly instead of raising ``AttributeError`` on an
    envelope whose ``meta`` is ``null`` rather than an object.
    """
    meta = page.get("meta") if isinstance(page, dict) else None
    pagination = meta.get("pagination") if isinstance(meta, dict) else None
    return pagination.get("next_cursor") if isinstance(pagination, dict) else None


def metagraphed_paginate(
    path: str,
    *,
    base_url: str = DEFAULT_BASE_URL,
    path_params: Optional[Mapping[str, Any]] = None,
    query: Optional[Mapping[str, Any]] = None,
    headers: Optional[Mapping[str, str]] = None,
    timeout: float = 30.0,
    retries: int = 0,
    backoff: float = 0.5,
) -> Iterator[Any]:
    """Yield each page's envelope for a list endpoint, following
    ``meta.pagination.next_cursor`` until it is exhausted."""
    base_query = dict(query or {})
    cursor = base_query.get("cursor")
    state: dict = {}
    while True:
        page_query = dict(base_query)
        if cursor is not None:
            page_query["cursor"] = cursor
        page = metagraphed_fetch(
            path,
            base_url=base_url,
            path_params=path_params,
            query=page_query,
            headers=headers,
            timeout=timeout,
            retries=retries,
            backoff=backoff,
        )
        cursor = _next_catalog_cursor(page, page_query, state)
        if "page_snapshot" in page_query:
            base_query["page_snapshot"] = page_query["page_snapshot"]
        yield page
        if cursor is None:
            return


def _collection_rows(page: Any) -> List[Any]:
    """Extract the row list from a single list-endpoint page.

    List endpoints nest their rows under ``data[meta['pagination']['collection']]``
    (e.g. ``data['subnets']``), not as a bare array. Resolve the collection key,
    falling back to a flat ``data`` list or the single list-valued field. Mirrors
    the TypeScript client's ``fetchAll``.
    """
    if not isinstance(page, dict):
        return []
    data = page.get("data")
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    meta = page.get("meta")
    pagination = meta.get("pagination") if isinstance(meta, dict) else None
    collection = pagination.get("collection") if isinstance(pagination, dict) else None
    if isinstance(collection, str) and isinstance(data.get(collection), list):
        return data[collection]
    arrays = [value for value in data.values() if isinstance(value, list)]
    return arrays[0] if len(arrays) == 1 else []


def metagraphed_fetch_all(
    path: str,
    *,
    base_url: str = DEFAULT_BASE_URL,
    path_params: Optional[Mapping[str, Any]] = None,
    query: Optional[Mapping[str, Any]] = None,
    headers: Optional[Mapping[str, str]] = None,
    timeout: float = 30.0,
    retries: int = 0,
    backoff: float = 0.5,
) -> List[Any]:
    """Follow pagination for a list endpoint and return every row across all
    pages (the nested ``data`` collection; see :func:`_collection_rows`)."""
    items: List[Any] = []
    for page in metagraphed_paginate(
        path,
        base_url=base_url,
        path_params=path_params,
        query=query,
        headers=headers,
        timeout=timeout,
        retries=retries,
        backoff=backoff,
    ):
        items.extend(_collection_rows(page))
    return items


def metagraphed_rpc(
    network: str,
    method: str,
    params: Optional[Sequence[Any]] = None,
    *,
    base_url: str = DEFAULT_BASE_URL,
    headers: Optional[Mapping[str, str]] = None,
    timeout: float = 30.0,
    request_id: Any = 1,
    retries: int = 0,
    backoff: float = 0.5,
) -> Any:
    """Call the read-only Subtensor RPC proxy (POST ``/rpc/v1/<network>``) and
    return the JSON-RPC ``result``. Raises :class:`MetagraphedError` on a network
    failure, a non-2xx response, or a JSON-RPC-level error object.

    The proxy is a read-only Subtensor read, so RPC reads are retried exactly
    like idempotent GETs: set ``retries`` > 0 to retry transient errors (HTTP
    429/5xx and network failures) with exponential ``backoff`` seconds, honoring
    a numeric ``Retry-After`` capped at 60 seconds. Retries are opt-in
    (default 0)."""
    url = (
        base_url.rstrip("/")
        + "/rpc/v1/"
        + urllib.parse.quote(str(network), safe="")
    )
    payload = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": list(params or []),
        }
    ).encode("utf-8")

    parsed = _request_json(
        _build_request(url, method="POST", data=payload, headers=headers),
        timeout=timeout,
        retries=retries,
        backoff=backoff,
        label=f"RPC {method}",
    )
    return _jsonrpc_result(parsed, method)


class MetagraphedClient:
    """Convenience wrapper binding a ``base_url`` + default
    ``timeout``/``retries``/``backoff`` (applied to GETs and RPC reads alike)."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = 30.0,
        retries: int = 0,
        backoff: float = 0.5,
    ) -> None:
        self.base_url = base_url
        self.timeout = timeout
        self.retries = retries
        self.backoff = backoff

    def fetch(
        self,
        path: str,
        *,
        path_params: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> Any:
        """GET ``path`` using this client's ``base_url`` + ``timeout`` + ``retries``."""
        return metagraphed_fetch(
            path,
            base_url=self.base_url,
            path_params=path_params,
            query=query,
            headers=headers,
            timeout=self.timeout,
            retries=self.retries,
            backoff=self.backoff,
        )

    def paginate(
        self,
        path: str,
        *,
        path_params: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> Iterator[Any]:
        """Iterate every page of a list endpoint (follows ``next_cursor``)."""
        return metagraphed_paginate(
            path,
            base_url=self.base_url,
            path_params=path_params,
            query=query,
            headers=headers,
            timeout=self.timeout,
            retries=self.retries,
            backoff=self.backoff,
        )

    def rpc(
        self,
        network: str,
        method: str,
        params: Optional[Sequence[Any]] = None,
        *,
        headers: Optional[Mapping[str, str]] = None,
        request_id: Any = 1,
    ) -> Any:
        """Call the read-only RPC proxy and return the JSON-RPC ``result``.

        Honors this client's ``retries`` + ``backoff``: RPC reads are retried on
        transient errors exactly like GETs (see :func:`metagraphed_rpc`)."""
        return metagraphed_rpc(
            network,
            method,
            params,
            base_url=self.base_url,
            headers=headers,
            timeout=self.timeout,
            request_id=request_id,
            retries=self.retries,
            backoff=self.backoff,
        )

    def fetch_all(
        self,
        path: str,
        *,
        path_params: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> List[Any]:
        """Follow pagination and return every item (flattened ``data`` arrays)."""
        return metagraphed_fetch_all(
            path,
            base_url=self.base_url,
            path_params=path_params,
            query=query,
            headers=headers,
            timeout=self.timeout,
            retries=self.retries,
            backoff=self.backoff,
        )

    # -- typed convenience methods (the raw-dict path stays via fetch/fetch_all) --

    def subnets(self, **query: Any) -> List[Subnet]:
        """Every subnet as a typed :class:`~metagraphed.models.Subnet`.

        Rows come from the compact ``/api/v1/subnets`` index, which populates
        ``integration_readiness`` but not ``completeness_score`` (that score
        lives on profiles / the agent catalog). Sort with
        ``sort="integration_readiness"``, not ``completeness_score``.
        """
        return Subnet.list_from(
            self.fetch_all("/api/v1/subnets", query=query or None)
        )

    def get_subnet(self, netuid: Any) -> SubnetDetail:
        """One subnet detail artifact as a typed
        :class:`~metagraphed.models.SubnetDetail`."""
        envelope = self.fetch(
            "/api/v1/subnets/{netuid}", path_params={"netuid": netuid}
        )
        data = envelope.get("data") if isinstance(envelope, dict) else None
        subnet = data.get("subnet") if isinstance(data, dict) else None
        return SubnetDetail.from_dict(subnet)

    def surfaces(self, **query: Any) -> List[Surface]:
        """Every surface as a typed :class:`~metagraphed.models.Surface`."""
        return Surface.list_from(
            self.fetch_all("/api/v1/surfaces", query=query or None)
        )

    def endpoints(self, **query: Any) -> List[Endpoint]:
        """Every endpoint as a typed :class:`~metagraphed.models.Endpoint`."""
        return Endpoint.list_from(
            self.fetch_all("/api/v1/endpoints", query=query or None)
        )

    def providers(self, **query: Any) -> List[Provider]:
        """Every provider as a typed :class:`~metagraphed.models.Provider`."""
        return Provider.list_from(
            self.fetch_all("/api/v1/providers", query=query or None)
        )

    def get_provider(self, slug: Any) -> Provider:
        """One provider as a typed :class:`~metagraphed.models.Provider`."""
        envelope = self.fetch(
            "/api/v1/providers/{slug}", path_params={"slug": slug}
        )
        data = envelope.get("data") if isinstance(envelope, dict) else None
        provider = data.get("provider") if isinstance(data, dict) else None
        return Provider.from_dict(provider)

    def candidates(self, **query: Any) -> List[CandidateSurface]:
        """Every candidate as a typed
        :class:`~metagraphed.models.CandidateSurface`."""
        return CandidateSurface.list_from(
            self.fetch_all("/api/v1/candidates", query=query or None)
        )

    def profiles(self, **query: Any) -> List[SubnetProfile]:
        """Every subnet profile as a typed
        :class:`~metagraphed.models.SubnetProfile`."""
        return SubnetProfile.list_from(
            self.fetch_all("/api/v1/profiles", query=query or None)
        )

    def health(self) -> HealthSummary:
        """Global operational health as a typed
        :class:`~metagraphed.models.HealthSummary`."""
        envelope = self.fetch("/api/v1/health")
        data = envelope.get("data") if isinstance(envelope, dict) else None
        return HealthSummary.from_dict(data)

    def agent_catalog(self, netuid: Any) -> AgentCatalogSubnet:
        """One subnet's agent catalog as a typed
        :class:`~metagraphed.models.AgentCatalogSubnet`."""
        envelope = self.fetch(
            "/api/v1/agent-catalog/{netuid}", path_params={"netuid": netuid}
        )
        data = envelope.get("data") if isinstance(envelope, dict) else None
        return AgentCatalogSubnet.from_dict(data)
