# ADR 0015 — Realtime firehose architecture: Postgres NOTIFY tee, not an indexer push

- **Status:** Accepted
- **Date:** 2026-07-12
- **Relates to:** #2114 (Durable Object firehose, the epic this ADR scopes),
  its five sub-issues #4980–#4984, #2108 (the hybrid-infra master epic),
  ADR 0014 (chain-data infrastructure — the self-hosted core this firehose
  reads from), `docs/realtime-streamer.md` (the retired predecessor whose
  failure mode this ADR explicitly designs around).

## Context

#2114 originally specified the firehose as "the indexer tees each decoded
batch to it" — a Durable Object fed by a direct push from `indexer-rs`'s own
live-follow process. ADR 0014 documents, in detail, why that exact shape
already failed once: `metagraphed-streamer` (a separate Python live-follow
process, since stopped) pushed decoded rows synchronously into the Worker's
D1 write path, and a blocking retry loop on a failed write starved the same
connection servicing its chain-head subscription. A subscription reconnect
silently, permanently skipped whatever finalized during the gap — no crash,
no error, just missing data, measured at 38–61% missing in some windows near
the chain tip. It was resolved by removing the redundant pipeline entirely,
not by hardening the coupling.

Building #2114 as literally worded — `indexer-rs` synchronously tees each
batch to a Durable Object — reintroduces the identical risk shape: a new
required write/push inside `indexer-rs`'s critical live-follow path, whose
failure (Cloudflare unreachable, a slow DO, a network blip) can now compete
for the same resources that keep the indexer following the chain head.
ADR 0014's Decision point 5 already establishes the operating principle this
ADR follows: "one first-party live indexer is enough" — nothing new should
add a second thing `indexer-rs` must not fail to do.

ADR 0014 supersedes ADR 0013's _core data-infrastructure_ topology in full,
but says nothing about the firehose specifically — it neither describes nor
forecloses this feature. The Cloudflare-edge / self-hosted-box-core split
ADR 0013 established and ADR 0014 keeps intact (Worker REST/GraphQL/MCP,
Hyperdrive, R2, KV, Vectorize, the RPC proxy all stay on Cloudflare; the
archive node, `indexer-rs`, Postgres/Timescale, Redis all stay on the
dedicated box) is unaffected by this ADR and remains the basis for where the
firehose's two halves live.

## Decision

1. **The tee is Postgres's own `LISTEN`/`NOTIFY`, driven by an `AFTER INSERT`
   trigger on `blocks`/`extrinsics`/`chain_events` — not a push from
   `indexer-rs`.** A trigger fires only after a row is durably committed; by
   construction it cannot affect whether that commit succeeded. `indexer-rs`
   requires zero code changes and has zero awareness the firehose exists.
   This is the load-bearing safety property of the whole design — see #4980.
2. **A new, separate box-side relay process bridges Postgres to Cloudflare**
   (#4981), subscribing via `LISTEN` and forwarding to the Durable Object over
   HTTP with a bounded, drop-oldest retry policy. If this process is down,
   lagging, or can't reach Cloudflare, the only consequence is the firehose
   stalls — `indexer-rs` and Postgres are completely unaffected. This process
   is new self-hosted infrastructure (Docker container on the indexer box,
   Ansible-managed per the existing `streamer` role's precedent in
   `deploy/README.md`), not a Cloudflare-side component.
3. **The hub itself is a Cloudflare Durable Object** (#4982), consistent with
   the edge/core split above — it's the first DO this codebase has used, and
   needs a `wrangler.jsonc` migration (one-way/versioned; get the class shape
   right the first time). It serves SSE and WS directly, using hibernatable
   WebSocket handling so idle subscribers don't pin DO compute.
4. **GraphQL subscriptions and MCP resource subscriptions (#4983) are thin
   protocol adapters over the same DO connection**, not a second event
   pipeline — one hub, four transports, matching #2114's original framing.
5. **The alerter (#4984) is a consumer of the hub, not a parallel path** —
   it subscribes like any other client, evaluates trigger definitions against
   the stream, and reuses the existing webhook delivery infrastructure
   (`/api/v1/webhooks/subscriptions`) for its webhook leg rather than building
   a second one.

## Consequences

**Gains:** the firehose's reliability is structurally decoupled from
`indexer-rs`'s — the one property ADR 0014's incident review says matters
most. No second live-follow pipeline is introduced (unlike the retired
streamer, which was a second live-follow process against the chain itself;
this design has exactly one, `indexer-rs`, and everything downstream reads
from what it already durably writes).

**Costs / risks — tracked, not hand-waved:**

- **A new box-side service is new operational surface** (#4981) — it needs
  the same Ansible-managed, reproducible deployment discipline `deploy/README.md`
  already establishes for `streamer`/`indexer-rs`, not an ad-hoc SSH-installed
  process, or it becomes exactly the kind of undocumented, unreproducible
  infrastructure this repo's deploy runbook exists to prevent.
- **NOTIFY payloads are capped at 8000 bytes by Postgres itself** — the
  trigger must send a compact reference payload, not full row data, which
  means the bridge/DO may need a re-fetch path for consumers that want more
  than the headline fields. Scoped explicitly in #4980.
- **This is the first Durable Object in the codebase** — no existing pattern
  to copy from within this repo; #4982's implementation is genuine new-pattern
  work and should get commensurate review care, not a rubber stamp because
  "it's just another Worker route."
- **Five sequential dependencies** (#4980 → #4981 → #4982 → #4983/#4984) —
  a stall in any one blocks the rest; sequencing matters more here than in
  most feature work.

## Links/resources

- #2114, #4980, #4981, #4982, #4983, #4984 — the epic and its five sub-issues
- ADR 0014 — the incident review this ADR's core safety property is derived
  from (Decision point 5 specifically)
- `docs/realtime-streamer.md` — the retired predecessor, kept as the
  documented cautionary precedent
- `deploy/postgres/schema.sql` — where #4980's trigger lands
- `deploy/README.md` — the Ansible-managed self-hosted deployment convention
  #4981's relay process must follow
