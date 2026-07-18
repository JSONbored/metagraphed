# Deployment — the `metagraphed-core` self-hosted topology (ADR 0014)

The architecture and rationale live in
[`docs/adr/0014-chain-data-infrastructure-and-postgres-cutover.md`](../docs/adr/0014-chain-data-infrastructure-and-postgres-cutover.md)
— it supersedes ADR 0013's Railway/D1 topology in full. The realtime firehose
on top of this core has its own ADR
([0015](../docs/adr/0015-realtime-firehose-architecture.md)); `indexer-rs`'s
move from a private repo into `apps/indexer-rs/` has its own too
([0016](../docs/adr/0016-indexer-rs-consolidation.md)). This is the
**operator runbook**: what runs where, the exact provisioning commands, and
the gated cutover steps.

```
Chain → full archive subtensor-node (syncing) ─┐
Chain → pruned fullnode subtensor-node ────────┴→ indexer-rs (live-follow) → Postgres/Timescale
                                                          │                        │
                                          (AFTER INSERT trigger, ADR 0015)   Hyperdrive, pooled+cached
                                                          ▼                        ▼
                                          chain-firehose-relay        CF Worker (REST/GraphQL/MCP)
                                                          │
                                                          ▼
                              CF Durable Object firehose (SSE/WS/GraphQL-subs) + alerter (#4984)
Railway: wss-lb only (everything else that used to run there has moved to the boxes or Cloudflare)
R2 = artifacts · Parquet/CSV exports · Postgres backups (zero-egress)
```

## Topology

Three dedicated bare-metal boxes (Latitude.sh, real hostnames/IPs live only in
the private `metagraphed-infra` Ansible inventory — never in this repo), plus
Cloudflare edge and one Railway service. Verified directly against the running
infrastructure, not inherited from prior docs:

| Tier                 | Where                                               | Pieces                                                                                                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge (rented)        | **Cloudflare**                                      | Worker serving, **Hyperdrive** → Postgres, **Durable Object** firehose + alerter (#4984), R2, KV, Vectorize, Workers AI, rate-limiters, RPC proxy. The health-prober and rollups also still run here (CF crons) — moving them to the indexer box is tracked separately (#2113), not done.                                        |
| Indexer box (owned)  | dedicated bare-metal                                | `indexer-rs` (live-follow), `chain-firehose-relay` (the ADR 0015 box-side relay), TimescaleDB (chain data), a separate Postgres (registry data), Redis (cursor state). `indexer-rs-backfill` (sharded historical backfill) is currently **stopped** — paused deliberately so the archive node's own sync gets full I/O headroom. |
| Archive box (owned)  | dedicated bare-metal, separate from the indexer box | `subtensor` full archive node (`--pruning=archive --sync=full`). **Still syncing** — not yet at chain tip.                                                                                                                                                                                                                       |
| Fullnode box (owned) | dedicated bare-metal, third box                     | `subtensor` **pruned**, warp-synced node. This, not the archive node, is `indexer-rs`'s current live-follow RPC source (`EVENTS_RPC_URL`) — it reached chain tip fast and isn't competing with the archive node's own sync for I/O.                                                                                              |
| Railway              | `wss-lb` only                                       | Everything else that previously ran on Railway (`postgres`/`redis`/`indexer-rs`, the `metagraphed-streamer` project) has moved to the boxes above or been retired; `exporter`/`reconciler` (#2115, dataset exports + drift detection) don't exist yet.                                                                           |

There is no Hetzner escape hatch — ADR 0013's "Railway core, Hetzner escape
hatch" framing described a plan overtaken by events; the team went straight to
bare metal instead.

## Railway: `wss-lb`, the only service left

The `metagraphed-core` Railway project once held `postgres`/`redis`/`indexer`
too (ADR 0013's topology); all of that has since moved to the dedicated boxes
above, leaving `wss-lb` as the project's only service — verified live via
`railway status` (production environment, `wss-lb` online at
`https://wss.metagraph.sh`).

- **Config-as-code**: `wss-lb`'s Railway service reads `/deploy/wss-lb/railway.json`
  (Railway does **not** auto-discover it from a subdirectory — set the
  service's **Settings → Config-as-code → "Railway Config File"** to that
  **absolute** repo-root path; it does **not** follow Root Directory).
  Builds its Dockerfile from the **repo-root** build context (leave Root
  Directory unset) and scopes redeploys with `watchPatterns`, so an unrelated
  merge never triggers a pointless rebuild.
- `wss-lb`'s own provisioning detail lives in
  [`deploy/wss-lb/README.md`](wss-lb/README.md).

## Bare-metal bring-up

**Production runs across three separate boxes, provisioned via the private
`JSONbored/metagraphed-infra` Ansible repo** (`roles/subtensor-archive`,
`roles/subtensor-fullnode`, `roles/indexer-rust`, `roles/postgres-timescale`,
`roles/redis`, `roles/chain-firehose-relay`) — that repo's inventory holds the
real hostnames/IPs and is the actual source of truth for what's deployed
where. `deploy/docker-compose.yml` below is a **single-box reference/dev
setup** (Postgres + Redis + a subtensor node co-located, so every hop is
localhost) — useful for local development or a from-scratch bring-up, but it
is not how production is actually composed across the three boxes:

```bash
cp deploy/.env.example deploy/.env     # set POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

That starts:

- **`postgres`** (TimescaleDB) — applies `deploy/postgres/schema.sql` then the
  optional `deploy/postgres/schema-timescaledb.sql` on first boot; never binds
  a public port (Cloudflare reaches it via Hyperdrive over a tunnel).
- **`redis`** — the indexer cursor + heartbeat mirror.
- **`subtensor`** — a **full archive** finney node (`--pruning=archive --sync=full`:
  complete state from genesis). Needs **~8 TB+ NVMe**; the from-genesis full
  sync takes days — production's own archive box is still mid-sync (see the
  Topology table above). (Dev: `SUBTENSOR_PRUNING=2000 SUBTENSOR_SYNC=warp`
  for a small pruned node instead.)
- **`indexer`** — not defined in `docker-compose.yml`. Production's
  `indexer-rs` (live-follow + sharded historical backfill, `apps/indexer-rs/`
  in this repo since the ADR 0016 consolidation) is deployed to its own box
  via the Ansible role above, built from a manually-transferred Docker image
  rather than this compose file — repointing that build source to
  `apps/indexer-rs/` is tracked separately (#5150), not yet done.

**Managed Railway Postgres is no longer used** — it was the interim home for
`postgres`/`redis`/`indexer-rs` before the dedicated boxes existed; both the
data and the live Hyperdrive binding have since moved to the indexer box's own
Postgres. `wss-lb`'s own provisioning is documented in
[`deploy/wss-lb/README.md`](wss-lb/README.md).

## Cloudflare side

**Serving cutover is complete** — `blocks`/`extrinsics`/`account_events`/
`neurons`/`neuron_daily` all serve from Postgres via Hyperdrive; D1's
write/prune/ingest code for these five tiers, and the D1 tables themselves,
are fully retired (#4772, PR #4908, 2026-07-11). There is no D1 fallback left
to roll back to for them. What follows is how the cutover was done, kept for
reference if the same tier-by-tier pattern is ever needed again (e.g. for a
future tier):

- **Gate first.** Before cutting a tier, compare Postgres vs D1 row counts over
  a recent window — only cut once Postgres ≥ D1 across the window. A shortfall
  here becomes a serving regression; investigate before proceeding.
- **Private DB path.** Postgres must never be public — front it with a Cloudflare
  Tunnel + Workers VPC service, then create the Hyperdrive config from the
  **Cloudflare dashboard** so the database password is entered into Cloudflare's
  credential form, never passed as a shell-expanded argument (shell history,
  process listings, CI logs all record argv). Add the `[[hyperdrive]]` binding to
  `wrangler.jsonc` and read via `env.HYPERDRIVE.connectionString`.
- **Cut tier by tier**, D1 as fallback during the migration window (`if
FLAG[tier] == "postgres": try Postgres; on error → D1`), watching latency +
  correctness before the next tier, then delete the fallback branch and the D1
  write path once every tier is stable.

The Durable Object firehose hub is a binding in the Worker. Per ADR 0015, the
indexer does **not** push to it directly — a Postgres outbox table (populated
by an `AFTER INSERT` trigger) decouples the indexer's own critical live-follow
path from Cloudflare reachability; a separate box-side relay process polls the
outbox and forwards to the Durable Object for SSE/WS/GraphQL-subscription
fan-out.

## Gated steps — DO NOT run unsupervised

Each needs a human who can verify/roll back (ADR 0014 _Sequencing_):

1. 🔲 **`subtensor-node`** — **full archive** (~3.5 TB+, ~8 TB+ NVMe volume):
   complete state from genesis, so it serves first-party archive RPC +
   self-sufficient backfill. **Still syncing as of this writing** (tracked in
   #2111 — network path to the indexer node, Worker RPC-proxy wiring, and the
   Ansible role are all still open sub-steps too). Seed from a snapshot to
   skip the multi-day from-genesis sync.
2. ✅ **Live serving cutover** — `blocks` / `extrinsics` / `account_events` /
   `neurons` / `neuron_daily` are all flipped to Postgres via Hyperdrive,
   D1's write/prune/ingest code for them retired (#4772, PR #4908,
   2026-07-11 — see item 4 below).
3. 🔲 **Full historical re-backfill** (genesis-to-tip, archive-gated) —
   **currently paused**, not shipped: the interim single-shard backfill
   against a rate-limited public RPC was deliberately stopped so the archive
   node's own sync gets full I/O headroom, and the plan is to repoint the
   sharded backfill (`BACKFILL_SHARDS`) at the archive node's own RPC once
   item 1 finishes. Don't confuse this with item 2 above — live serving is
   cut over and stable; it's the deep historical window that's still gated
   on the archive node.
4. ✅ **Decommissioned** (#4772, 2026-07-11): the chain-data `*/3` R2-staging
   drain (`loadStagedNeurons`/`Events`/`Blocks`/`Extrinsics`), the realtime
   ingest endpoints, the D1-side daily rollup/archive/prune crons, the manual
   `backfill-events.yml`/`scripts/{stream,fetch,backfill}-events.py` streamer
   cluster, and D1's `blocks`/`extrinsics`/`account_events`/`neurons`/
   `neuron_daily` tables + prune logic are all retired — Postgres (indexer-rs
   live-follow + sharded historical backfill) is the sole source for chain
   data now. `account_position_daily` (no Postgres serving route yet) and the
   health/registry-monitoring tables (`surface_checks` and friends,
   `subnet_snapshots`, `account_events_daily`) are explicitly NOT part of
   this — D1 stays their permanent, unrelated home. (The GitHub `*/5` poller
   and the `metagraphed-streamer` Railway project were already decommissioned
   2026-07-04, ahead of and independent from this gated cutover — see the
   note above.)

### `blocks` tier verification queries (#4687)

Before ever re-flipping `METAGRAPH_BLOCKS_SOURCE` to `"postgres"`, re-run these
against the indexer box's Postgres to confirm the historical gaps found in
#4687 are actually closed — a single spot-checked block (as #4668's original
flip relied on) does not prove this:

```sh
ssh <indexer-ssh-target>
sudo docker exec -i <postgres-container> psql -U <postgres-user> -d <postgres-database>
```

```sql
-- 1. Zero empty-string authors (the spec_version 419/421/422 backfill-decode
--    gap; src/blocks.mjs's formatBlock() already mitigates this at the
--    serving layer regardless, but the underlying rows should be repaired).
SELECT count(*) FROM blocks WHERE author = '';

-- 2. Zero missing block_numbers across the known coverage hole.
SELECT gs.block_number
FROM generate_series(8471001, 8479999) AS gs(block_number)
LEFT JOIN blocks b ON b.block_number = gs.block_number
WHERE b.block_number IS NULL;

-- 3. Same check across the full D1-retained window, as a general regression
--    guard (adjust the lower bound to D1's current min if it has moved).
SELECT gs.block_number
FROM generate_series(8474393, (SELECT max(block_number) FROM blocks)) AS gs(block_number)
LEFT JOIN blocks b ON b.block_number = gs.block_number
WHERE b.block_number IS NULL;
```

All three must return zero rows before considering the `blocks` tier's
historical coverage trustworthy again. Do **not** flag D1's own gap at block
`8513820` as a Postgres regression — D1 is missing that block, not Postgres;
it's expected and orthogonal (D1 is being decommissioned, not backfilled).

## Backup job (Postgres → R2)

The scheduled durability job (`pg_dump | gzip | aws s3 cp` to R2, zero egress) is
managed as private infrastructure tooling, not in this public repo. Restoring a
dump is minutes; re-backfilling history is weeks.

**Verify it actually restores, not just that it uploads** — a backup that's
never been restore-tested is only half-verified. Spin up a scratch Postgres
(same image/version as the source), restore the dump into it, and compare
row counts per table against the live source before trusting the job.

## Backups + PITR (mandatory)

Postgres holds derived state. It is **re-derivable** (re-index from the chain via
the archive node), but a full re-index is slow — so back it up; you just don't
need a near-zero RPO.

- **Full continuous PITR is optional / overkill here.** PITR buys a seconds-level
  RPO via continuous WAL — worth it for un-recreatable OLTP data, but our worst
  case is "re-index the last day from chain," which a daily snapshot already
  bounds. It also adds WAL-storage cost. Skip it unless the re-index window
  becomes painful; the `pg_dump` → R2 job above is enough.
- The DB volume + backups are the storage-cost driver; when they outgrow the
  box's disk (TimescaleDB compression ~10–20×), that is the trigger to plan
  additional storage — see ADR 0014.
