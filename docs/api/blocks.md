# Blocks endpoint group (`/api/v1/blocks`, `/api/v1/extrinsics`)

Consumer-facing reference for the block-explorer endpoint group of the
Metagraphed Worker API, served from `https://api.metagraph.sh/api/v1/*`. These
routes expose the first-party block/extrinsic/event tiers that back the
[block explorer](https://metagraph.sh/blocks) (#1345) — the recent-block and
recent-extrinsic feeds, per-block and per-extrinsic detail, and the events
within a block.

All routes are **read-only, public, no-auth** `GET`s that return the standard
`/api/v1` JSON envelope. This page documents each route's parameters and shape;
the cross-cutting envelope, pagination, header, and error-code semantics live in
[`api-stability.md`](../api-stability.md) and are only summarized here.

> Related groups: account-signed history (`/accounts/{ss58}/extrinsics`,
> `/accounts/{ss58}/events`) is documented under the Accounts group, and the
> subnet event stream (`/subnets/{netuid}/events`) under the Subnets group. This
> page covers the block- and extrinsic-scoped surfaces only.

## At a glance

| Route                             | Purpose                                                          |
| --------------------------------- | --------------------------------------------------------------- |
| `GET /blocks`                     | Recent-block feed (newest first), filterable + CSV export       |
| `GET /blocks/summary`             | Block-production analytics over recent blocks                   |
| `GET /blocks/{ref}`               | Per-block detail by block number or `0x` hash                   |
| `GET /blocks/{ref}/extrinsics`    | Extrinsics contained in one block                               |
| `GET /blocks/{ref}/events`        | Decoded, account-attributed chain events in one block           |
| `GET /blocks/{ref}/chain-events`  | Raw pallet-level events in one block (all-events tier)          |
| `GET /extrinsics`                 | Recent-extrinsic feed (newest first), filterable + CSV export   |
| `GET /extrinsics/{hash}`          | Per-extrinsic detail by hash or `<block>-<index>` id            |

## Conventions

- **Base URL** — `https://api.metagraph.sh/api/v1`.
- **Envelope** — every response is `{ ok, schema_version, data, meta }`; branch on
  `ok`. Errors are `{ ok: false, error: { code, message } }`. See
  [Response Envelope](../api-stability.md#response-envelope).
- **`{ref}`** — a block reference is either a decimal `block_number` (e.g.
  `4210000`) or a `0x`-prefixed 64-hex-char `block_hash`. Both resolve to the
  same block.
- **Cold reads never 404** — an unknown/not-yet-indexed block or extrinsic
  returns `200` with the nullable payload zeroed (`block: null`,
  `extrinsic: null`, `extrinsics: []`, `events: []`) so clients stay
  schema-stable. Malformed refs return `400 invalid_query`.
- **Pagination** — list routes take `?limit` (default `100`) and `?offset`, or
  `?cursor=<n>` for stable keyset paging under head-of-chain inserts (#1851).
  `meta.pagination` carries `total`, `returned`, `limit`, `cursor`,
  `next_cursor` (null at end).
- **CSV** — the two feed routes (`/blocks`, `/extrinsics`) accept `?format=csv`
  to download the filtered rows as `text/csv` instead of the JSON envelope.
- **Freshness** — computed live from the first-party D1 tiers; read
  `meta.published_at` for the human "last updated" time (not `generated_at`).

## `GET /blocks`

Recent-block feed, newest first, for the block explorer.

**Query parameters** — `limit` (≤100), `offset`, `cursor`, and a conjunctive
(AND-ed) filter set (#1991): `author=<ss58>`, `spec_version=<n>`, `from`/`to`
(`observed_at` epoch-ms), `block_start`/`block_end` (height range),
`min_extrinsics`/`min_events` (non-empty blocks), `format=csv`.

```sh
curl "https://api.metagraph.sh/api/v1/blocks?limit=2&min_extrinsics=1"
```

```jsonc
{
  "ok": true,
  "schema_version": 1,
  "data": {
    "blocks": [
      {
        "block_number": 4210000,
        "block_hash": "0x…",
        "author": "5F…",
        "spec_version": 220,
        "extrinsic_count": 3,
        "event_count": 12,
        "observed_at": "2026-07-14T18:22:41.000Z",
      },
    ],
  },
  "meta": {
    "pagination": { "total": 100, "returned": 2, "limit": 2, "next_cursor": 2 },
  },
}
```

## `GET /blocks/summary`

Block-production analytics over recent blocks: inter-block time distribution,
extrinsic/event throughput, block-author decentralization (concentration over
each author's block count), and the spec-version spread. Returns a
schema-stable, zeroed card when the tier is cold. No query parameters.

```sh
curl "https://api.metagraph.sh/api/v1/blocks/summary"
```

## `GET /blocks/{ref}`

Per-block detail by numeric `block_number` or `0x` `block_hash`. Returns `200`
with `block: null` when the block is cold/unknown.

```sh
curl "https://api.metagraph.sh/api/v1/blocks/4210000"
```

```jsonc
{
  "ok": true,
  "schema_version": 1,
  "data": {
    "block": {
      "block_number": 4210000,
      "block_hash": "0x…",
      "parent_hash": "0x…",
      "author": "5F…",
      "spec_version": 220,
      "extrinsic_count": 3,
      "event_count": 12,
      "prev_block_number": 4209999,
      "next_block_number": 4210001,
      "observed_at": "2026-07-14T18:22:41.000Z",
    },
  },
  "meta": {},
}
```

## `GET /blocks/{ref}/extrinsics`

The extrinsics in one block, in natural (index) order. `?limit` (≤100),
`?offset`. Returns `200` with `extrinsics: []` when the block is cold/unknown.

```sh
curl "https://api.metagraph.sh/api/v1/blocks/4210000/extrinsics"
```

## `GET /blocks/{ref}/events`

The decoded, account-attributed chain events in one block, in natural order.
`?limit` (≤1000), `?offset`. Sourced from the first-party `account_events` D1
tier filtered by `block_number` (#1852). Returns `200` with `events: []` when
cold/unknown.

```sh
curl "https://api.metagraph.sh/api/v1/blocks/4210000/events"
```

## `GET /blocks/{ref}/chain-events`

Every **raw** pallet-level event in one block (by numeric `block_number`,
`event_index` ascending), from the Postgres-backed all-events tier (ADR 0013).
Distinct from `/blocks/{ref}/events` (the curated, account-attributed D1
stream): this is the unfiltered pallet firehose for the block. Served live;
returns `{ count: 0, events: [] }` when the block is unknown or before the
all-events backfill has reached it.

```sh
curl "https://api.metagraph.sh/api/v1/blocks/4210000/chain-events"
```

## `GET /extrinsics`

Recent-extrinsic feed, newest first, for the block explorer.

**Query parameters** — `limit` (≤100), `offset`, `cursor`, and a conjunctive
filter set (#1846): `block=<n>`, `signer=<ss58>`, `call_module=`,
`call_function=`, `call_hash=` (`0x` 64-hex decoded call hash — requires
`call_module=` so the JSON scan stays scoped, #4322), `success=true|false`,
`block_start`/`block_end` (block range), `from`/`to` (`observed_at` epoch-ms),
`format=csv`.

```sh
curl "https://api.metagraph.sh/api/v1/extrinsics?call_module=SubtensorModule&success=true&limit=5"
```

## `GET /extrinsics/{hash}`

Per-extrinsic detail by `0x` `extrinsic_hash` **or** the composite
`<block_number>-<extrinsic_index>` id. Prefer the composite id: the on-chain
hash is best-effort/nullable, whereas the `<block>-<index>` id is always
present. Returns `200` with `extrinsic: null` when cold/unknown/malformed.

```sh
# by composite id (always present)
curl "https://api.metagraph.sh/api/v1/extrinsics/4210000-2"

# by 0x hash (best-effort)
curl "https://api.metagraph.sh/api/v1/extrinsics/0x…"
```

## See also

- [`api-stability.md`](../api-stability.md) — envelope, pagination, headers,
  error codes, and the stability contract for all `/api/v1` routes.
- [`block-explorer-data-model.md`](../block-explorer-data-model.md) — the D1 /
  all-events tiers and field semantics behind these routes.
- [`public/metagraph/openapi.json`](../../public/metagraph/openapi.json) — the
  canonical machine-readable contract (parameters, response schemas, examples).
