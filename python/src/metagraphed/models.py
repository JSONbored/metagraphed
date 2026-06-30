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
from typing import Any, ClassVar, List, Mapping, Optional


class _Model:
    """Mixin: build a dataclass from an API dict, ignoring unknown keys and
    stashing the full dict on ``.raw`` (so nothing is lost)."""

    raw: Mapping[str, Any]

    # Per-model alias map: API response key -> dataclass field name. The API and
    # the models mostly share names, but a few collections expose a field under a
    # different key (e.g. providers carry their slug as ``id``); without an alias
    # ``from_dict`` would leave the typed field ``None`` even though ``.raw`` has
    # the value. Subclasses override this.
    _aliases: ClassVar[Mapping[str, str]] = {}

    @classmethod
    def _known_kwargs(cls, mapping: Mapping[str, Any]) -> dict:
        """Project an API dict onto this model's fields.

        Direct name matches win; any ``_aliases`` entry (API key -> field) then
        fills a field the API exposes under a different key, so a renamed key
        such as provider ``id`` -> ``slug`` populates the typed field instead of
        silently staying ``None``.
        """
        known = {f.name for f in fields(cls) if f.name != "raw"}  # type: ignore[arg-type]
        kwargs = {name: mapping[name] for name in known if name in mapping}
        for source, target in cls._aliases.items():
            if target in known and target not in kwargs and source in mapping:
                kwargs[target] = mapping[source]
        return kwargs

    @classmethod
    def from_dict(cls, data: Any) -> Any:
        mapping = data if isinstance(data, Mapping) else {}
        instance = cls(**cls._known_kwargs(mapping))  # type: ignore[call-arg]
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
    # The providers API exposes the provider slug as ``id`` (no ``slug`` key).
    _aliases: ClassVar[Mapping[str, str]] = {"id": "slug"}
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
