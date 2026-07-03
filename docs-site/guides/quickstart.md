---
title: Quickstart
description: Three ways to integrate with Metagraphed in minutes.
---

# Quickstart

Metagraphed is the Bittensor subnet **integration registry** — public interfaces, health, schemas, and access metadata for every subnet. The live API is at [api.metagraph.sh](https://api.metagraph.sh); the web UI is at [metagraph.sh](https://metagraph.sh).

Pick one entry point:

## AI agent (MCP)

Agent-native, public, read-only. Install the MCP server and query subnets, health, economics, and callable APIs as tools.

```bash
claude mcp add --transport http metagraphed https://api.metagraph.sh/mcp
```

Cursor and other clients: add an MCP server with URL `https://api.metagraph.sh/mcp`, transport `streamable-http`.

See [Agent & MCP resources](../generated/resources.md) for the full tool list and machine-readable indexes.

## Typed client

Generated from the OpenAPI contract:

```bash
npm i @jsonbored/metagraphed   # JavaScript / TypeScript
pip install metagraphed        # Python
```

```javascript
import { metagraphedFetch } from "@jsonbored/metagraphed";

const { data } = await metagraphedFetch("/api/v1/subnets", {
  query: { limit: 10 },
});
```

## REST

Stable JSON envelope `{ ok, data, meta, error }`. OpenAPI at [`/metagraph/openapi.json`](https://api.metagraph.sh/metagraph/openapi.json).

```bash
curl -s https://api.metagraph.sh/api/v1/subnets
curl -s https://api.metagraph.sh/api/v1/subnets/7/profile | jq '.data'
curl -s https://api.metagraph.sh/api/v1/coverage | jq '.data.completeness'
```

## GraphQL

Shape one request across registry objects — subnet + health + surfaces + economics, provider + subnets, opportunity boards.

```bash
curl -s -X POST https://api.metagraph.sh/api/v1/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ subnet(netuid: 7) { name health { status } surfaces { kind url } } }"}'
```

## Next steps

- [API reference](../generated/api-reference.md) — every route, generated from the committed contract
- [Subnet catalog](../generated/catalog.md) — curated overlays from the registry
- [Contributing surfaces](./contributing.md) — add a public API, OpenAPI spec, or docs link for a subnet
- [Auth & rate limits](./auth-and-rate-limits.md) — CORS, caching, errors, client expectations
