# Realtime chain-event firehose (#2114, ADR 0015)

The `chain_firehose` Postgres channel: a compact, best-effort NOTIFY stream of
every row landing in `blocks`/`extrinsics`/`chain_events`, decoupled from
`indexer-rs`'s own write path so nothing downstream of it can ever affect
whether `indexer-rs` keeps following the chain head. See ADR 0015 for why this
shape was chosen over a direct push from `indexer-rs` (the retired
`metagraphed-streamer`'s exact failure mode, documented in ADR 0014).

## How it works

```
indexer-rs → (writes, as it always has) → Postgres
                                              │
                              AFTER INSERT trigger (deploy/postgres/schema.sql)
                                              │
                                    pg_notify('chain_firehose', <payload>)
                                              │
                          box-side relay (LISTEN, #4981) → Cloudflare Durable Object (#4982)
                                                                          │
                                                        SSE / WS / GraphQL subs / MCP (#4982, #4983)
```

`indexer-rs` requires **zero code changes** and has **zero awareness** any of
this exists — the trigger only fires after a row is already durably
committed, so a firehose outage (relay down, Cloudflare unreachable, the
Durable Object itself failing) has exactly one consequence: the live
subscription feed stalls. `indexer-rs`'s writes and Postgres's durability are
completely unaffected, by construction.

## The trigger (`deploy/postgres/schema.sql`)

`notify_chain_firehose()` is a single `plpgsql` function, reused by three
`AFTER INSERT ... FOR EACH ROW` triggers (one per table), each passed its
logical table name as an explicit trigger argument (`EXECUTE FUNCTION
notify_chain_firehose('blocks')`, read inside as `TG_ARGV[0]`). This is
deliberate, not stylistic: on a TimescaleDB hypertable, `TG_TABLE_NAME`
inside the function body resolves to the physical per-time-range CHUNK name
(e.g. `_hyper_1_379_chunk`), never the logical hypertable name — an earlier
version of this function branched on `TG_TABLE_NAME` and was a silent no-op
on every real insert as a result (verified live 2026-07-12). Payload is a
compact reference — table name + primary-key fields + a couple of headline
columns — not the full row, to stay well under Postgres's 8000-byte `NOTIFY`
payload cap. A subscriber that wants full row detail re-fetches by primary
key. Any error raised inside the trigger (e.g. a future oversized payload) is
swallowed, not propagated — firehose delivery must never be able to fail an
insert.

Row-level, not statement-level: simpler for a first cut, at the cost of one
`NOTIFY` per row rather than one per batch insert. If per-block NOTIFY volume
becomes a real bottleneck, the documented fast-follow is a statement-level
trigger with a `REFERENCING NEW TABLE AS new_rows` transition table.

## The relay (#4981, not yet built)

A new, small, self-hosted process on the indexer box — `LISTEN
chain_firehose;`, forward each notification to the Durable Object over HTTP,
bounded retry/drop-oldest under sustained Cloudflare-side unavailability.
Deployed via the same Ansible-managed convention as the (retired) `streamer`
role — see [`JSONbored/metagraphed-infra`](https://github.com/JSONbored/metagraphed-infra)
— not an ad-hoc SSH-installed process. Unlike the old streamer, this relay is
a pure consumer: it never writes to Postgres and is never in `indexer-rs`'s
critical path, so there is no equivalent of the old blocking-retry-starves-the-subscription
failure mode to guard against here.

## The hub + transports (#4982, #4983, not yet built)

A single Cloudflare Durable Object (`ChainFirehoseHub`) receives relay
forwards on an authenticated internal endpoint and fans them out over SSE
(`GET /api/v1/chain/stream`), WebSocket, a GraphQL `Subscription` type, and
MCP resource subscriptions — one hub, four transports.

## The alerter (#4984, not yet built)

A consumer of the same hub: evaluates user-defined trigger conditions against
the stream and delivers matches via webhook (reusing the existing
`/api/v1/webhooks/subscriptions` infrastructure), email, Telegram, or
Discord.

## Verifying the trigger locally

```sh
psql "$DATABASE_URL" -c "LISTEN chain_firehose;"
# in another session, insert (or wait for indexer-rs to insert) a row into
# blocks/extrinsics/chain_events — the LISTENing session prints a Notification
```
