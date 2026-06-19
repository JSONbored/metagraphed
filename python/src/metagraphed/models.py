"""Typed, optional response models for the main metagraphed collections (#749).

These are lightweight stdlib :mod:`dataclasses` — **zero extra dependencies** —
giving IDE autocomplete and typed access to the common fields of each
collection. ``.raw`` always holds the full parsed dict, so no field is ever
lost and forward-compatible additions keep working. The default client methods
still return raw dicts; these models are strictly opt-in (``Subnet.from_dict``
or the typed convenience methods such as ``client.subnets()``).
"""

from __future__ import annotations

from dataclasses import dataclass, field, fields
from typing import Any, List, Mapping, Optional


class _Model:
    """Mixin: build a dataclass from an API dict, ignoring unknown keys and
    stashing the full dict on ``.raw`` (so nothing is lost)."""

    raw: Mapping[str, Any]

    @classmethod
    def from_dict(cls, data: Any) -> Any:
        mapping = data if isinstance(data, Mapping) else {}
        known = {f.name for f in fields(cls)}  # type: ignore[arg-type]
        kwargs = {
            name: mapping.get(name)
            for name in known
            if name != "raw" and name in mapping
        }
        instance = cls(**kwargs)  # type: ignore[call-arg]
        instance.raw = dict(mapping)
        return instance

    @classmethod
    def list_from(cls, items: Any) -> List[Any]:
        """Build a list of models from an API list (``data`` array)."""
        return (
            [cls.from_dict(item) for item in items]
            if isinstance(items, list)
            else []
        )


@dataclass
class Subnet(_Model):
    netuid: Optional[int] = None
    slug: Optional[str] = None
    name: Optional[str] = None
    subnet_type: Optional[str] = None
    status: Optional[str] = None
    categories: Optional[List[str]] = None
    completeness_score: Optional[float] = None
    integration_readiness: Optional[int] = None
    updated_at: Optional[str] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)


@dataclass
class Surface(_Model):
    id: Optional[str] = None
    netuid: Optional[int] = None
    kind: Optional[str] = None
    name: Optional[str] = None
    url: Optional[str] = None
    provider: Optional[str] = None
    auth_required: Optional[bool] = None
    public_safe: Optional[bool] = None
    schema_url: Optional[str] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)


@dataclass
class Endpoint(_Model):
    surface_id: Optional[str] = None
    netuid: Optional[int] = None
    kind: Optional[str] = None
    url: Optional[str] = None
    base_url: Optional[str] = None
    provider: Optional[str] = None
    classification: Optional[str] = None
    monitoring_status: Optional[str] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)


@dataclass
class Provider(_Model):
    slug: Optional[str] = None
    name: Optional[str] = None
    authority: Optional[str] = None
    surface_count: Optional[int] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)


@dataclass
class AgentCatalogSubnet(_Model):
    netuid: Optional[int] = None
    slug: Optional[str] = None
    name: Optional[str] = None
    subnet_type: Optional[str] = None
    completeness_score: Optional[float] = None
    integration_readiness: Optional[int] = None
    service_count: Optional[int] = None
    services: Optional[List[Mapping[str, Any]]] = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)
