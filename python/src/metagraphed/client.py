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
from typing import Any, Iterator, Mapping, Optional, Sequence

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
# A descriptive User-Agent is required: api.metagraph.sh sits behind a Cloudflare
# managed bot rule that returns HTTP 403 for stdlib urllib's default
# "Python-urllib/<ver>" UA. Callers may override it via the ``headers`` argument.
DEFAULT_USER_AGENT = (
    f"metagraphed-python/{__version__} (+https://github.com/JSONbored/metagraphed)"
)
_PATH_PARAM = re.compile(r"\{([^{}]+)\}")


class MetagraphedError(Exception):
    """Raised on a network failure or a non-2xx HTTP response."""

    def __init__(self, message: str, *, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status


def _interpolate(path: str, path_params: Optional[Mapping[str, Any]]) -> str:
    params = path_params or {}

    def repl(match: "re.Match[str]") -> str:
        name = match.group(1)
        if name not in params or params[name] is None:
            raise MetagraphedError(f"Missing path parameter: {name}")
        return urllib.parse.quote(str(params[name]), safe="")

    return _PATH_PARAM.sub(repl, path)


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
    a numeric ``Retry-After`` header. Retries are opt-in (default 0).
    """
    url = base_url.rstrip("/") + _interpolate(path, path_params)
    if query:
        pairs = [(key, value) for key, value in query.items() if value is not None]
        if pairs:
            url += "?" + urllib.parse.urlencode(pairs, doseq=True)

    # Defaults first so a caller-supplied header (e.g. a custom User-Agent) wins.
    merged_headers = {"Accept": "application/json", "User-Agent": DEFAULT_USER_AGENT}
    merged_headers.update(headers or {})

    request = urllib.request.Request(url, method="GET")
    for key, value in merged_headers.items():
        request.add_header(key, value)

    attempt = 0
    while True:
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8")
            break
        except urllib.error.HTTPError as error:
            if attempt < retries and error.code in _RETRY_STATUSES:
                time.sleep(_retry_delay(error, attempt, backoff))
                attempt += 1
                continue
            raise MetagraphedError(
                f"GET {url} failed: HTTP {error.code}{_error_detail(error)}",
                status=error.code,
            ) from error
        except urllib.error.URLError as error:
            if attempt < retries:
                time.sleep(backoff * (2**attempt))
                attempt += 1
                continue
            raise MetagraphedError(f"GET {url} failed: {error.reason}") from error

    try:
        return json.loads(body)
    except ValueError as error:
        raise MetagraphedError(
            f"GET {url} returned a non-JSON response"
        ) from error


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
            return max(0.0, float(int(retry_after)))
        except (TypeError, ValueError):
            pass
    return backoff * (2**attempt)


def _error_detail(error: "urllib.error.HTTPError") -> str:
    """Best-effort extraction of the API's error envelope from a failed response.

    api.metagraph.sh returns ``{ error: { code, message } }`` on errors; surface
    that (or a truncated raw body) so callers can see *why* a request failed
    instead of a bare status code. Never raises.
    """
    try:
        raw = error.read().decode("utf-8", "replace").strip()
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


def metagraphed_paginate(
    path: str,
    *,
    base_url: str = DEFAULT_BASE_URL,
    path_params: Optional[Mapping[str, Any]] = None,
    query: Optional[Mapping[str, Any]] = None,
    headers: Optional[Mapping[str, str]] = None,
    timeout: float = 30.0,
    retries: int = 0,
) -> Iterator[Any]:
    """Yield each page's envelope for a list endpoint, following
    ``meta.pagination.next_cursor`` until it is exhausted."""
    base_query = dict(query or {})
    cursor = base_query.get("cursor")
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
        )
        yield page
        pagination = (
            page.get("meta", {}).get("pagination")
            if isinstance(page, dict)
            else None
        )
        cursor = (
            pagination.get("next_cursor") if isinstance(pagination, dict) else None
        )
        if cursor is None:
            return


def metagraphed_rpc(
    network: str,
    method: str,
    params: Optional[Sequence[Any]] = None,
    *,
    base_url: str = DEFAULT_BASE_URL,
    headers: Optional[Mapping[str, str]] = None,
    timeout: float = 30.0,
    request_id: Any = 1,
) -> Any:
    """Call the read-only Subtensor RPC proxy (POST ``/rpc/v1/<network>``) and
    return the JSON-RPC ``result``. Raises :class:`MetagraphedError` on a network
    failure, a non-2xx response, or a JSON-RPC-level error object."""
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

    merged_headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": DEFAULT_USER_AGENT,
    }
    merged_headers.update(headers or {})

    request = urllib.request.Request(url, data=payload, method="POST")
    for key, value in merged_headers.items():
        request.add_header(key, value)

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        raise MetagraphedError(
            f"RPC {method} failed: HTTP {error.code}{_error_detail(error)}",
            status=error.code,
        ) from error
    except urllib.error.URLError as error:
        raise MetagraphedError(f"RPC {method} failed: {error.reason}") from error

    try:
        parsed = json.loads(body)
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


class MetagraphedClient:
    """Convenience wrapper binding a ``base_url`` + default ``timeout``/``retries``."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = 30.0,
        retries: int = 0,
    ) -> None:
        self.base_url = base_url
        self.timeout = timeout
        self.retries = retries

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
        """Call the read-only RPC proxy and return the JSON-RPC ``result``."""
        return metagraphed_rpc(
            network,
            method,
            params,
            base_url=self.base_url,
            headers=headers,
            timeout=self.timeout,
            request_id=request_id,
        )
