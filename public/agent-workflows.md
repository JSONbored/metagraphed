# Agent workflows for callable subnet discovery

This is the practical path from "I want to build on a Bittensor subnet" to a
working call. Use this when you need task-oriented guidance instead of a raw
endpoint list.

Everything below is public, read-only, and served from
`https://api.metagraph.sh`. REST responses use the envelope
`{ ok, schema_version, data, meta }`; read `data`.

## Choose an interface

Use the interface that matches your environment:

- MCP: best for Claude, Cursor, ChatGPT Apps, and agent frameworks that can call
  tools. Connect `https://api.metagraph.sh/mcp`.
- REST: best for shell scripts, browser apps, and quick inspection.
- npm: best for TypeScript apps that want typed API paths.
- Python: best for notebooks, crawlers, and backend jobs.

All four paths read the same registry truth. MCP gives the most guided workflow;
REST and SDKs give you the same data directly.

## 1. Find callable subnet candidates

Start with the agent catalog. It is the subset of subnets with at least one
catalogued public integration surface.

REST:

```bash
curl -sS 'https://api.metagraph.sh/api/v1/agent-catalog?limit=10'
```

MCP:

```bash
curl -sS 'https://api.metagraph.sh/mcp' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"find_subnet_for_task","arguments":{"task":"bitcoin yield or routing API","limit":5}}}'
```

npm:

```ts
import { metagraphedFetch } from "@jsonbored/metagraphed";

const catalog = await metagraphedFetch("/api/v1/agent-catalog", {
  query: { limit: 10 },
});

for (const subnet of catalog.data.subnets) {
  console.log(
    subnet.netuid,
    subnet.name,
    subnet.callable_count,
    subnet.service_kinds,
  );
}
```

Python:

```python
from metagraphed import MetagraphedClient

client = MetagraphedClient()
catalog = client.fetch("/api/v1/agent-catalog", query={"limit": 10})

for subnet in catalog["data"]["subnets"]:
    print(
        subnet["netuid"],
        subnet["name"],
        subnet.get("callable_count"),
        subnet.get("service_kinds"),
    )
```

If the user's request is vague, ask the registry rather than guessing:

```bash
curl -sS 'https://api.metagraph.sh/api/v1/ask' \
  -H 'content-type: application/json' \
  -d '{"question":"Which Bittensor subnets expose public APIs for inference or developer tooling, and how should I call them?"}'
```

## 2. Inspect one subnet before calling it

Use SN7 as a concrete example. Swap `7` for any netuid from the catalog.

REST:

```bash
curl -sS 'https://api.metagraph.sh/api/v1/agent-catalog/7'
curl -sS 'https://api.metagraph.sh/api/v1/subnets/7/health'
```

MCP:

```bash
curl -sS 'https://api.metagraph.sh/mcp' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"how_do_i_call","arguments":{"netuid":7}}}'
```

npm:

```ts
import { metagraphedFetch } from "@jsonbored/metagraphed";

const catalog = await metagraphedFetch("/api/v1/agent-catalog/{netuid}", {
  pathParams: { netuid: 7 },
});

const callable = catalog.data.services.filter(
  (service) => service.eligibility?.callable,
);

for (const service of callable) {
  console.log({
    surface_id: service.surface_id,
    base_url: service.base_url,
    auth_required: service.auth_required,
    health: service.health?.status,
    snippets: service.snippets,
  });
}
```

Python:

```python
from metagraphed import MetagraphedClient

client = MetagraphedClient()
catalog = client.agent_catalog(7)

callable_services = [
    service
    for service in (catalog.services or [])
    if service.get("eligibility", {}).get("callable")
]

for service in callable_services:
    print(
        service["surface_id"],
        service["base_url"],
        service.get("auth_required"),
        service.get("health", {}).get("status"),
        service.get("snippets"),
    )
```

Do not treat a catalogued surface as production-ready just because it exists.
Check `eligibility.callable`, `auth_required`, `auth_schemes`, schema
availability, and the live `health` block first.

To live-probe one catalogued surface on demand, use the service's `surface_id`
or stable `surface_key`:

```bash
curl -sS 'https://api.metagraph.sh/api/v1/surfaces/allways-api-health/verify'
```

MCP equivalent:

```bash
curl -sS 'https://api.metagraph.sh/mcp' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"verify_integration","arguments":{"surface_id":"allways-api-health"}}}'
```

This is a catalog-resolved probe, not arbitrary URL fetching. It verifies the
curated URL already known to metagraphed and is cached briefly to avoid fan-out.

## 3. Fetch schema and fixture examples

The agent catalog tells you which service to call. If a service has
`schema_artifact`, fetch the captured machine-readable contract:

```bash
curl -sS 'https://api.metagraph.sh/metagraph/schemas/{surface_id}.json'
```

For no-auth GET surfaces with captured samples, use fixtures:

```bash
curl -sS 'https://api.metagraph.sh/metagraph/fixtures/{surface_id}.json'
```

MCP equivalents:

```bash
curl -sS 'https://api.metagraph.sh/mcp' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_api_schema","arguments":{"surface_id":"allways-api-health"}}}'

curl -sS 'https://api.metagraph.sh/mcp' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_fixture","arguments":{"surface_id":"allways-api-health"}}}'
```

If the schema or fixture is absent, say that plainly and fall back to the
service's `base_url`, `auth` metadata, and generated snippets. Do not invent a
request shape.

## 4. Make the first call

Prefer the snippets already carried by the agent catalog or returned by
`how_do_i_call`. They are generated from the curated `base_url` and auth
metadata.

REST inspection:

```bash
curl -sS 'https://api.metagraph.sh/api/v1/agent-catalog/7'
```

Then read:

- `data.services[].snippets.curl`
- `data.services[].snippets.python`
- `data.services[].snippets.typescript`

If `auth_required` is `true`, the user needs a credential from that subnet's
team. Metagraphed tells you which scheme is required; it does not provide,
broker, or guess secrets.

## 5. Ask semantic questions with provenance

Use `/api/v1/ask` when the user wants an answer, not a raw list:

```bash
curl -sS 'https://api.metagraph.sh/api/v1/ask' \
  -H 'content-type: application/json' \
  -d '{"question":"Which callable subnets have public developer-tooling APIs, and what evidence supports that?"}'
```

Use `/api/v1/search/semantic` when the user wants candidate rows:

```bash
curl -sS 'https://api.metagraph.sh/api/v1/search/semantic?q=developer%20tooling%20api'
```

The AI routes are grounded in the registry. They can still be unavailable if the
AI layer is down or rate-limited, so a robust agent should fall back to
`/api/v1/agent-catalog`, `/api/v1/subnets`, and MCP keyword tools.

## Readiness criteria

A subnet is agent-ready only when a developer or agent can decide what to call
and how to call it without guessing.

Included in the agent catalog:

- The subnet has at least one public-safe, catalogued integration surface.
- At least one service is marked `eligibility.callable`.
- The service has a concrete `base_url`.
- Auth is explicitly declared as none or described through `auth_required` and
  `auth_schemes`.
- The surface is not private, unsafe, parked-only, deprecated-only, or purely a
  Bittensor base-layer endpoint.
- Health, schema, fixture, and snippet data are included when available, with
  absence represented as absence rather than fabricated detail.

Common blockers:

- No public API, docs, repo, or operator-owned surface has been found.
- The only known surface is a marketing page, dashboard, Discord, X profile, or
  generic repo with no callable interface.
- Auth is required but the scheme or onboarding path is unclear.
- There is no stable base URL.
- The schema is missing, stale, or not machine-readable.
- The surface failed public-safety checks or points at private/internal
  infrastructure.
- The subnet is parked, deprecated, candidate-only, or otherwise not suitable
  for an integration recommendation.

For machine-readable explanations, read
`GET https://api.metagraph.sh/api/v1/agent-catalog`. The `subnets` array is the
callable subset. The `blocked_subnets` array contains the rest of the registry,
each with `agent_readiness.status`, `agent_readiness.blocker_level`,
`agent_readiness.blockers[]`, and `agent_readiness.missing_fields[]`. Use those
fields when the user asks why a subnet is not agent-ready yet.

When a service has a schema, `schema_artifact` points at the captured contract
and `schema_source` explains how it was attached. `surface-id` and `schema-url`
matches are exact. `same-origin-openapi` means Metagraphed found a captured
OpenAPI surface for the same subnet and origin; inspect the schema artifact
before generating endpoint-specific request bodies. For MCP, pass
`schema_source.surface_id` to `get_api_schema` when it is present.

## Agent loop

Use this loop for integration tasks:

1. Call `find_subnet_for_task` or `GET /api/v1/agent-catalog`.
2. Pick a subnet with `callable_count > 0` and relevant `service_kinds`.
3. Call `how_do_i_call` or `GET /api/v1/agent-catalog/{netuid}`.
4. Check `auth_required`, `auth_schemes`, `health.status`, and schema/fixture
   availability.
5. Use `verify_integration` or `/api/v1/surfaces/{surface_id}/verify` when the
   user needs "callable right now" before wiring an integration.
6. Use the returned snippet as the first call.
7. If required data is missing, explain the blocker and link the missing field
   back to the catalog instead of guessing.
