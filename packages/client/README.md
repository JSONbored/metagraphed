# @metagraphed/client

Typed TypeScript client for the [metagraph.sh](https://metagraph.sh) backend API —
operational metadata, health, schemas, and public-interface discovery for
Bittensor subnets.

The client is generated from the live, versioned `openapi.json`, so request
paths, query parameters, and response shapes are fully typed and stay in lockstep
with the API contract.

## Install

```sh
npm install @metagraphed/client
```

## Usage

```ts
import { metagraphedFetch } from "@metagraphed/client";

// Fully typed path + query params + response envelope.
const subnets = await metagraphedFetch("/api/v1/subnets", {
  query: { limit: 10, sort: "completeness_score", order: "desc" },
});
console.log(subnets.data, subnets.meta.pagination);

// One call for everything a subnet page needs.
const overview = await metagraphedFetch("/api/v1/subnets/{netuid}/overview", {
  pathParams: { netuid: 7 },
});

// Point at a different origin (e.g. a preview deployment).
const health = await metagraphedFetch("/api/v1/health", {
  baseUrl: "https://metagraph.sh",
});
```

Every response is the standard envelope `{ ok, schema_version, data, meta }`
(`meta.pagination` on list routes, `meta.published_at` for freshness). See the
[API stability guide](https://github.com/JSONbored/metagraphed/blob/main/docs/api-stability.md)
for the envelope, pagination, caching, error codes, and `x-metagraph-*` headers.

## Versioning

The package tracks the `/api/v1` contract; changes within v1 are additive. The
exported types are regenerated from `openapi.json` on each release.
