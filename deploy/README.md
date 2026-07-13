# Deployment — the `metagraphed-core` hybrid (ADR 0013)

The architecture and rationale live in [`docs/adr/0013-hybrid-deployment-topology.md`](../docs/adr/0013-hybrid-deployment-topology.md).
This is the **operator runbook**: what runs where, the exact provisioning
commands, and the gated cutover steps.

```
Chain → full archive subtensor-node → indexer → Postgres/Timescale
                                              │
                          (Cloudflare Hyperdrive, pooled + cached)
                                              ▼
            CF Worker (REST/GraphQL/MCP) + Durable Object firehose (SSE/WS)
Railway crons/workers (prober · rollups · alerter · exporter · reconciler) ─ all read/write Postgres over private net
R2 = artifacts · Parquet/CSV exports · Postgres backups (zero-egress)
```

## Topology

| Tier          | Where                                                     | Pieces                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge (rented) | **Cloudflare**                                            | Worker serving, **Hyperdrive** → Postgres, **Durable Object** firehose, R2, KV, Vectorize, Workers AI, rate-limiters, RPC proxy                                                          |
| Core (owned)  | **Dedicated box** (data plane) + **Railway** (light glue) | box: `subtensor-node` (**full archive**, ~3.5 TB+ NVMe) + `postgres` + `redis` + `indexer`; Railway: `wss-lb` + crons (`health-prober`, `rollups`, `alerter`, `exporter`, `reconciler`). |
| Escape hatch  | **Hetzner** (later)                                       | `postgres` (+ optional node) when compressed history > ~300–500 GB or the 1 TB Railway cap looms — see ADR 0013                                                                          |

One Railway **project**, two **environments** (`production`, `staging`), one
private network (`<service>.railway.internal`, zero egress). The
`metagraphed-streamer` project has already been moved off Railway (2026-07-04,
self-hosted via the Ansible `streamer` role, verified stable) and the Railway
project deleted. The `postgres` / `redis` / `indexer-rs` / `pg-backup`
services described as "interim, until the box is live" in earlier revisions
of this doc are also now gone — the box's own Postgres/Redis/indexer are the
real, permanent core (verified: Railway's data was migrated over first, and
the box's Postgres now has its own working backup, see "Backup job" below).
`wss-lb` is the only Railway service left in this project.

## Railway: one project, many services

A Railway **project** is the unit that groups cooperating services — the docs call
it "an application stack, a service group" — so **all** of metagraphed-core's
services (`postgres`, `redis`, `subtensor-node`, `indexer`, the crons, and the
public `wss-lb`) live in **one project**, **not** one project each. Only
same-project + same-environment services get the automatic **private network**
(`<service>.railway.internal`, Wireguard-encrypted) and **reference variables**
`${{Postgres.DATABASE_URL}}` / `${{Redis.REDIS_URL}}`; split them across projects
and you lose internal DNS + cross-service vars and must wire public URLs by hand.

**Two config layers — this is the "is it all one `railway.json`?" answer: no.**

- **Per-service build config** (`railway.json` / `railway.toml`): each service reads
  its OWN file. Railway does **not** auto-discover it from a subdirectory — set the
  service's **Settings → Config-as-code → "Railway Config File"** to an **absolute**
  repo-root path (it does **not** follow Root Directory):
  - `wss-lb` → `/deploy/wss-lb/railway.json` (the only compute service left on Railway)
  - `postgres` / `redis` / `indexer` are **not** Railway services anymore — they run
    on the dedicated box (see the Bare-metal section below). The Python
    `scripts/index-chain.py`/`backfill-chain.py` this repo used to ship a Railway
    Dockerfile for are retired in favor of a Rust implementation, deployed
    directly to the box (its source doesn't have a git home in this repo yet).

  Each builds its Dockerfile from the **repo-root** build context (leave Root
  Directory unset) and scopes redeploys with `watchPatterns`, so an unrelated
  merge never triggers a pointless rebuild.

- **Whole-project config** (`.railway/railway.ts`, project-as-code): defines ALL
  services + DBs + variables + references in **one file**, applied with
  `railway config plan` / `railway config apply`. Scaffold with `railway config init`
  (or `railway config pull` to import the live project). This is the cleanest way to
  define + version the entire topology as code once the service set stabilizes.

## Bare-metal bring-up (the recommended core — one command)

With a dedicated server (the cost-optimal home for the storage-heavy node +
Postgres, ADR 0013), co-locate **node + TimescaleDB + Redis + indexer** in one
stack so every hop is localhost. The whole core comes up with:

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
  complete state from genesis), the head source + first-party RPC origin + the
  indexer's self-sufficient backfill source. Needs **~8 TB+ NVMe**; the from-genesis
  full sync takes days, so seed the volume from an opentensor archive snapshot when
  available. (Dev: `SUBTENSOR_PRUNING=2000 SUBTENSOR_SYNC=warp` for a small pruned
  node; deep backfill then comes from the public archive via `EVENTS_RPC_URL`.)
- **`indexer`** — not defined in `docker-compose.yml` yet. The real implementation
  is Rust (live-follow + sharded historical backfill in one binary, faster and
  more capable than the retired Python `scripts/index-chain.py`/`backfill-chain.py`),
  but its source has no git remote yet — give it one, add its service back to
  the compose file with a real Dockerfile, then bring it up here. It follows the
  finalized head from the durable cursor and idempotently writes `blocks` /
  `extrinsics` / `account_events` / `chain_events` into Postgres; **verify ~100%
  capture vs D1 before any serving cutover** (the ADR 0013 gate).

**Managed Railway Postgres is no longer used** — it was the interim home for
`postgres`/`redis`/`indexer-rs` before the dedicated box existed; both the data
and the live Hyperdrive binding have since moved to the box's own Postgres
(migrated + verified, then the Railway `postgres`/`redis`/`indexer-rs`/
`pg-backup` services and their volumes were deleted). `wss-lb`'s own
provisioning is documented in [`deploy/wss-lb/README.md`](wss-lb/README.md).

## Cloudflare side

The full, gated **serving cutover** (D1 → Postgres via Hyperdrive over a Tunnel +
Workers VPC, tier-by-tier with D1 fallback):

- **Gate first.** Before touching serving, compare Postgres vs D1 row counts over
  a recent window per tier (`blocks`, `extrinsics`, `account_events`) — only cut a
  tier once Postgres ≥ D1 across the window. A shortfall here becomes a serving
  regression; investigate before proceeding.
- **Private DB path.** Postgres must never be public — front it with a Cloudflare
  Tunnel + Workers VPC service, then create the Hyperdrive config from the
  **Cloudflare dashboard** so the database password is entered into Cloudflare's
  credential form, never passed as a shell-expanded argument (shell history,
  process listings, CI logs all record argv). Add the `[[hyperdrive]]` binding to
  `wrangler.jsonc` and read via `env.HYPERDRIVE.connectionString`.
- **Cut tier by tier**, D1 as fallback (`if FLAG[tier] == "postgres": try
Postgres; on error → D1`), watching latency + correctness before the next tier.
  Leave the indexer's Postgres writes and the D1 write/prune paths running until
  every tier is stable (dual-write during migration). Roll back per-tier by
  flipping the flag back to D1.

The Durable Object firehose hub is a new binding in the Worker; the `indexer`
tees each decoded batch to it for SSE/WS/GraphQL-subscription fan-out.

## Gated steps — DO NOT run unsupervised

Each needs a human who can verify/roll back (ADR 0013 _Sequencing_):

1. **`subtensor-node`** — **full archive** (~3.5 TB+, ~8 TB+ NVMe volume): complete
   state from genesis, so it serves first-party archive RPC + self-sufficient
   backfill. Seed from a snapshot to skip the multi-day from-genesis sync.
2. **`indexer` + one-time backfill** — then **verify ~100 % capture vs D1**
   before trusting it.
3. **Serving cutover** — point the Worker at Hyperdrive→Postgres **tier by tier**
   (blocks → extrinsics → accounts → metagraph), D1 as fallback; only then delete
   the prune-and-discard logic.
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

`deploy/backup/` is the scheduled durability job — `pg_dump | gzip | aws s3 cp` to
R2 (zero egress). Restoring a dump is minutes; re-backfilling history is weeks.

One-time setup:

1. Create an R2 bucket (e.g. `metagraphed-backups`) + an **R2 API token** (S3
   access key + secret) in the Cloudflare dashboard.
2. Build `deploy/backup/Dockerfile` on the box, write the required env vars
   (`DATABASE_URL` pointed at the box's local Postgres, `R2_BUCKET`,
   `R2_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `BACKUP_PREFIX`)
   to a root-only env file, then install and enable
   `deploy/backup/metagraphed-pg-backup.{service,timer}` — see the header
   comment in the `.service` file for the exact steps. This is the current,
   live deployment path (there is no Railway Postgres left to back up via a
   Railway cron service anymore).
3. Set an **R2 lifecycle rule** on the bucket for retention, scoped to the
   `BACKUP_PREFIX` used — e.g. `indexer-postgres/`, expire after 14 days (the
   robust way, not a script-side prune). Use a distinct `BACKUP_PREFIX` per
   Postgres instance backed up to the same bucket, so dumps from different
   databases don't collide under one prefix.

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
  additional storage — see ADR 0013.
