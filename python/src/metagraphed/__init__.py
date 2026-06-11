"""metagraphed — thin Python client for the Bittensor subnet registry API."""

from .client import (
    DEFAULT_BASE_URL,
    MetagraphedClient,
    MetagraphedError,
    metagraphed_fetch,
)

__version__ = "0.1.0"
__all__ = [
    "DEFAULT_BASE_URL",
    "MetagraphedClient",
    "MetagraphedError",
    "metagraphed_fetch",
    "__version__",
]
