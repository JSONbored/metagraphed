"""Thin Python client for the metagraphed API (https://api.metagraph.sh).

Dependency-free (stdlib ``urllib`` only). Mirrors the generated TypeScript
client: one generic GET helper over the uniform, read-only API surface,
returning the parsed ``{ ok, schema_version, data, meta }`` envelope as a dict.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Mapping, Optional

__version__ = "0.1.1"
DEFAULT_BASE_URL = "https://api.metagraph.sh"
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
) -> Any:
    """GET ``path`` against metagraphed and return the parsed JSON envelope.

    ``path`` may contain ``{name}`` segments filled from ``path_params``.
    ``query`` values that are ``None`` are dropped. Raises
    :class:`MetagraphedError` on a network failure or a non-2xx response.
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

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        raise MetagraphedError(
            f"GET {url} failed: HTTP {error.code}{_error_detail(error)}",
            status=error.code,
        ) from error
    except urllib.error.URLError as error:
        raise MetagraphedError(f"GET {url} failed: {error.reason}") from error

    try:
        return json.loads(body)
    except ValueError as error:
        raise MetagraphedError(
            f"GET {url} returned a non-JSON response"
        ) from error


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
        return f": {code + ' — ' if code else ''}{envelope['message']}"
    return f": {raw[:200]}"


class MetagraphedClient:
    """Convenience wrapper binding a ``base_url`` + default ``timeout``."""

    def __init__(
        self, base_url: str = DEFAULT_BASE_URL, *, timeout: float = 30.0
    ) -> None:
        self.base_url = base_url
        self.timeout = timeout

    def fetch(
        self,
        path: str,
        *,
        path_params: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> Any:
        """GET ``path`` using this client's ``base_url`` + ``timeout``."""
        return metagraphed_fetch(
            path,
            base_url=self.base_url,
            path_params=path_params,
            query=query,
            headers=headers,
            timeout=self.timeout,
        )
