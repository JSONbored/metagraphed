# @jsonbored/metagraphed

Typed TypeScript client for the [metagraph.sh](https://metagraph.sh) backend API —
operational metadata, health, schemas, and public-interface discovery for
Bittensor subnets.

The client is generated from the live, versioned `openapi.json`, so request
paths, query parameters, and response shapes are fully typed and stay in lockstep
with the API contract.

## Install

```sh
npm install @jsonbored/metagraphed
```

## Usage

```ts
import { metagraphedFetch } from "@jsonbored/metagraphed";

// Fully typed path + query params + response envelope.
const subnets = await metagraphedFetch("/api/v1/subnets", {
  query: { limit: 10, sort: "completeness_score", order: "desc" },
});
console.log(subnets.data, subnets.meta.pagination);

// One call for everything a subnet page needs.
const overview = await metagraphedFetch("/api/v1/subnets/{netuid}/overview", {
  pathParams: { netuid: 7 },
});

// Point at a different origin, and tune/disable the request timeout.
const health = await metagraphedFetch("/api/v1/health", {
  baseUrl: "https://metagraph.sh",
  timeoutMs: 5000, // default 30000; pass 0 to disable; an explicit `signal` wins
});
```

A resolved value is always a **success** envelope. On any non-2xx the client
**throws** a `MetagraphedError` carrying the HTTP status, the API error code, and
the parsed error envelope — so you branch with try/catch, not on `ok`:

```ts
import { metagraphedFetch, MetagraphedError } from "@jsonbored/metagraphed";

try {
  const subnet = await metagraphedFetch("/api/v1/subnets/{netuid}", {
    pathParams: { netuid: 7 },
  });
  console.log(subnet.data);
} catch (error) {
  if (error instanceof MetagraphedError) {
    // error.status (e.g. 404), error.code (e.g. "artifact_not_found"), error.envelope
    if (error.code === "rate_limited") {
      /* back off and retry */
    }
  }
}
```

### Paginate a list endpoint

`metagraphedPaginate` follows `meta.pagination.next_cursor` until it's exhausted:

```ts
import { metagraphedPaginate } from "@jsonbored/metagraphed";

for await (const page of metagraphedPaginate("/api/v1/subnets", {
  query: { limit: 100 },
})) {
  for (const subnet of page.data) console.log(subnet.netuid);
}
```

### Call the read-only RPC proxy

`metagraphedRpc` POSTs a JSON-RPC request to the Subtensor proxy
(`/rpc/v1/<network>`) and returns the `result`, throwing `MetagraphedError` on an
HTTP or JSON-RPC-level error:

```ts
import { metagraphedRpc } from "@jsonbored/metagraphed";

const healthInfo = await metagraphedRpc("finney", { method: "system_health" });
```

### Configured client: retries, ETag caching, convenience methods

`createMetagraphedClient` wraps the typed surface with opt-in retries/backoff,
opt-in ETag conditional caching, ergonomic per-collection methods, and a
`fetchAll` auto-pagination helper. Everything is opt-in and tree-shakeable — with
no options it behaves exactly like `metagraphedFetch`.

```ts
import { createMetagraphedClient } from "@jsonbored/metagraphed";

const client = createMetagraphedClient({
  // Opt-in retries on 429/5xx + transport errors (network / timeout) — exponential
  // backoff + jitter, honors Retry-After. Caller-initiated aborts are never retried.
  retry: { retries: 3 }, // or `retry: true` for defaults
  // Opt-in ETag conditional caching: revalidates with If-None-Match, serves the
  // cached body on a 304. `true` uses a bounded in-memory LRU (size it with
  // `createLruEtagCache(n)`); or pass your own `{ get, set }` store.
  cache: true,
});

// Typed convenience methods for the v1 collections + single resources.
const subnets = await client.subnets({ limit: 10 });
const subnet7 = await client.getSubnet(7);
const provider = await client.getProvider("allways");

// fetchAll walks every page and returns the flattened rows.
const all = await client.fetchAll("/api/v1/subnets", { query: { limit: 100 } });

// request() / paginate() / rpc() share the same retry + cache config.
const health = await client.request("/api/v1/health");
```

Every REST response is the standard envelope `{ ok, schema_version, data, meta }`
(`meta.pagination` on list routes, `meta.published_at` for freshness). See the
[API stability guide](https://github.com/JSONbored/metagraphed/blob/main/docs/api-stability.md)
for the envelope, pagination, caching, error codes, and `x-metagraph-*` headers.

## Versioning

The package tracks the `/api/v1` contract; changes within v1 are additive. The
exported types are regenerated from `openapi.json` on each release.

## License

Apache-2.0 — see [LICENSE](./LICENSE). (The metagraphed backend itself is
AGPL-3.0; this client SDK is permissively licensed so you can embed it freely.)
