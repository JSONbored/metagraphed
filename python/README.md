# metagraphed (Python)

Thin, dependency-free Python client for **metagraphed** — the operational +
integration registry for Bittensor subnets at `https://api.metagraph.sh`.

It mirrors the [npm client](https://www.npmjs.com/package/@jsonbored/metagraphed):
one generic GET helper over the uniform, read-only API surface, returning the
parsed `{ ok, schema_version, data, meta }` envelope. Stdlib only — no transitive
dependencies.

## Install

```bash
pip install metagraphed
```

## Usage

```python
from metagraphed import MetagraphedClient, metagraphed_fetch

client = MetagraphedClient()  # base_url defaults to https://api.metagraph.sh

# List subnets (query params; None values are dropped). The /subnets collection
# nests its rows under data.subnets:
subnets = client.fetch(
    "/api/v1/subnets",
    query={"limit": 10, "sort": "completeness_score", "order": "desc"},
)
print(subnets["data"]["subnets"][0]["name"])

# One subnet by netuid (path params)
detail = client.fetch("/api/v1/subnets/{netuid}", path_params={"netuid": 7})

# Which subnets are buildable? (integration readiness lives in the agent catalog)
catalog = client.fetch("/api/v1/agent-catalog")

# Health of the registry itself:
health = metagraphed_fetch("/api/v1/health")
```

Every response is the standard envelope:

```python
{"ok": True, "schema_version": 1, "data": ..., "meta": {...}}
```

On a network failure or non-2xx response, a `MetagraphedError` is raised (with
`.status` for HTTP errors, and the API error code/message in the message).

### Retries, pagination, and the RPC proxy

```python
from metagraphed import (
    MetagraphedClient,
    metagraphed_paginate,
    metagraphed_rpc,
)

# Opt-in retry/backoff for idempotent GETs (retries 429/5xx + network errors,
# honoring a numeric Retry-After). Disabled by default.
client = MetagraphedClient(retries=3)

# Iterate every page of a list endpoint (follows meta.pagination.next_cursor):
for page in client.paginate("/api/v1/subnets", query={"limit": 100}):
    for subnet in page["data"]["subnets"]:
        print(subnet["netuid"])

# Call the read-only Subtensor RPC proxy and get back the JSON-RPC result:
info = metagraphed_rpc("finney", "system_health")
```

## Versioning & stability

Tracks the public `/api/v1` contract; changes are additive within v1. See the
backend's [API stability policy](https://github.com/JSONbored/metagraphed/blob/main/docs/api-stability.md).

## License

Apache-2.0 — see [LICENSE](./LICENSE). (The metagraphed backend itself is AGPL-3.0; this client SDK is permissively licensed so you can embed it freely.)
