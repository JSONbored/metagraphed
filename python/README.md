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

# List subnets (query params; None values are dropped)
subnets = client.fetch(
    "/api/v1/subnets",
    query={"limit": 10, "sort": "completeness_score", "order": "desc"},
)
print(subnets["data"][0]["name"])

# One subnet by netuid (path params)
detail = client.fetch("/api/v1/subnets/{netuid}", path_params={"netuid": 7})

# Which subnets are buildable? (integration readiness lives in the agent catalog)
catalog = client.fetch("/api/v1/agent-catalog")

# Point at the frontend origin instead, ad hoc:
metagraphed_fetch("/api/v1/health", base_url="https://metagraph.sh")
```

Every response is the standard envelope:

```python
{"ok": True, "schema_version": 1, "data": ..., "meta": {...}}
```

On a network failure or non-2xx response, a `MetagraphedError` is raised (with
`.status` for HTTP errors).

## Versioning & stability

Tracks the public `/api/v1` contract; changes are additive within v1. See the
backend's [API stability policy](https://github.com/JSONbored/metagraphed/blob/main/docs/api-stability.md).

## License

MIT
