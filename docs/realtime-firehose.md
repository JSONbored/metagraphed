# Realtime chain-event firehose (#2114, ADR 0015)

The `chain_firehose_outbox` table is a compact, best-effort stream source for
every row landing in `blocks`/`extrinsics`/`chain_events`, decoupled from
`indexer-rs`'s own process so downstream delivery cannot block the chain
follower. See ADR 0015 for why this shape was chosen over a direct push from
`indexer-rs` (the retired `metagraphed-streamer`'s exact failure mode,
documented in ADR 0014).

## How it works

```
indexer-rs → (writes, as it always has) → Postgres
                                              │
                              AFTER INSERT trigger (deploy/postgres/schema.sql)
                                              │
                                 INSERT chain_firehose_outbox(payload)
                                              │
                    box-side relay (poll/claim rows, #4981) → Cloudflare Durable Object (#4982)
                                                                          │
                                                        SSE / WS / GraphQL subs / MCP (#4982, #4983)
```

`indexer-rs` requires **zero code changes** and has **zero awareness** any of
this exists. The trigger writes compact references into a normal Postgres
outbox table in the same transaction as the indexed row. Downstream consumers
never use `LISTEN`/`NOTIFY`, so a stuck relay or any other listener cannot pin
Postgres's global async notification queue and make source-table commits fail
at commit time. Ordinary local database failures (for example disk exhaustion)
remain database failures; relay, Cloudflare, or Durable Object outages only
leave outbox rows pending.

## The trigger (`deploy/postgres/schema.sql`)

`enqueue_chain_firehose()` is a single `plpgsql` function, reused by three
`AFTER INSERT ... FOR EACH ROW` triggers (one per table), each passed its
logical table name as an explicit trigger argument (`EXECUTE FUNCTION
enqueue_chain_firehose('blocks')`, read inside as `TG_ARGV[0]`). This is
deliberate, not stylistic: on a TimescaleDB hypertable, `TG_TABLE_NAME`
inside the function body resolves to the physical per-time-range CHUNK name
(e.g. `_hyper_1_379_chunk`), never the logical hypertable name — an earlier
version of this function branched on `TG_TABLE_NAME` and was a silent no-op
on every real insert as a result (verified live 2026-07-12).

Payload is a compact reference — table name + primary-key fields + a couple
of headline columns — not the full row. A subscriber that wants full row detail
re-fetches by primary key. The function inserts that payload into
`chain_firehose_outbox`; the relay claims pending rows using the indexed
`delivered_at IS NULL` view of the table and then forwards them.

Row-level, not statement-level: simpler for a first cut, at the cost of one
outbox row per source row rather than one per batch insert. If per-block volume
becomes a real bottleneck, the documented fast-follow is a statement-level
trigger with a `REFERENCING NEW TABLE AS new_rows` transition table.

## The relay (#4981, not yet built)

A new, small, self-hosted process on the indexer box polls and claims pending
`chain_firehose_outbox` rows, forwards each payload to the Durable Object over
HTTP, and uses bounded retry/drop-oldest behavior under sustained
Cloudflare-side unavailability. It does **not** `LISTEN` on a Postgres channel:
PostgreSQL delivers `NOTIFY` at transaction commit and its global notification
queue can be held back by a listener that remains in a transaction; if that
queue fills, committing transactions that executed `NOTIFY` can fail outside a
trigger-local exception block.

The relay is deployed via the same Ansible-managed convention as the (retired)
`streamer` role — see [`JSONbored/metagraphed-infra`](https://github.com/JSONbored/metagraphed-infra)
— not an ad-hoc SSH-installed process. Unlike the old streamer, this relay is
a pure consumer: it never writes to the source tables and is never in
`indexer-rs`'s process-level critical path, so there is no equivalent of the
old blocking-retry-starves-the-subscription failure mode to guard against here.

## The hub + transports (#4982, #4983, not yet built)

A single Cloudflare Durable Object (`ChainFirehoseHub`) receives relay
forwards on an authenticated internal endpoint and fans them out over SSE
(`GET /api/v1/chain/stream`), WebSocket, a GraphQL `Subscription` type, and
MCP resource subscriptions — one hub, four transports.

## The alerter (#4984, not yet built)

A consumer of the same hub: evaluates user-defined trigger conditions against
the stream and delivers matches via webhook (reusing the existing
`/api/v1/webhooks/subscriptions` infrastructure), email, Telegram, or Discord.

## Verifying the trigger locally

```sh
psql "$DATABASE_URL" -c "SELECT count(*) FROM chain_firehose_outbox WHERE delivered_at IS NULL;"
# in another session, insert (or wait for indexer-rs to insert) a row into
# blocks/extrinsics/chain_events, then query the pending outbox rows again.
```
