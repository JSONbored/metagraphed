"""metagraphed — thin Python client for the Bittensor subnet registry API."""

from .client import (
    DEFAULT_BASE_URL,
    DEFAULT_USER_AGENT,
    MetagraphedClient,
    MetagraphedError,
    __version__,
    metagraphed_fetch,
    metagraphed_fetch_all,
    metagraphed_paginate,
    metagraphed_rpc,
)
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

# Safe to import without httpx installed — httpx is imported lazily only when an
# AsyncMetagraphedClient is constructed (raising a clear error that points at the
# `metagraphed[async]` extra).
from .aio import AsyncMetagraphedClient

__all__ = [
    "AgentCatalogSubnet",
    "AsyncMetagraphedClient",
    "CandidateSurface",
    "DEFAULT_BASE_URL",
    "DEFAULT_USER_AGENT",
    "Endpoint",
    "HealthSummary",
    "MetagraphedClient",
    "MetagraphedError",
    "Provider",
    "Subnet",
    "SubnetDetail",
    "SubnetProfile",
    "Surface",
    "metagraphed_fetch",
    "metagraphed_fetch_all",
    "metagraphed_paginate",
    "metagraphed_rpc",
    "__version__",
]
