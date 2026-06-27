# Deployment — the `metagraphed-core` hybrid (ADR 0013)

The architecture and rationale live in [`docs/adr/0013-hybrid-deployment-topology.md`](../docs/adr/0013-hybrid-deployment-topology.md).
This is the **operator runbook**: what runs where, the exact provisioning
commands, and the gated cutover steps.

```
Chain → pruned subtensor-node → indexer → Postgres/Timescale
                                              │
                          (Cloudflare Hyperdrive, pooled + cached)
                                              ▼
            CF Worker (REST/GraphQL/MCP) + Durable Object firehose (SSE/WS)
Railway crons/workers (prober · rollups · alerter · exporter · reconciler) ─ all read/write Postgres over private net
R2 = artifacts · Parquet/CSV exports · Postgres backups (zero-egress)
```

## Topology

| Tier          | Where                                  | Pieces                                                                                                                          |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Edge (rented) | **Cloudflare**                         | Worker serving, **Hyperdrive** → Postgres, **Durable Object** firehose, R2, KV, Vectorize, Workers AI, rate-limiters, RPC proxy |
| Core (owned)  | **Railway project `metagraphed-core`** | `postgres`, `redis`, `subtensor-node` (pruned), `indexer`, `health-prober`, `rollups`, `alerter`, `exporter`, `reconciler`      |
| Escape hatch  | **Hetzner** (later)                    | `postgres` (+ optional node) when compressed history > ~300–500 GB or the 1 TB Railway cap looms — see ADR 0013                 |

One Railway **project**, two **environments** (`production`, `staging`), one
private network (`<service>.railway.internal`, zero egress). The existing
`metagraphed-streamer` project is **separate and untouched** — it is superseded
by `indexer` only at decommission (final step).

## Bare-metal bring-up (the recommended core — one command)

With a dedicated server (the cost-optimal home for the storage-heavy node +
Postgres, ADR 0013), co-locate **node + TimescaleDB + Redis + indexer** in one
stack so every hop is localhost. The whole core comes up with:

```bash
cp deploy/.env.example deploy/.env     # set POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

That starts:

- **`postgres`** (TimescaleDB) — applies `deploy/postgres/schema.sql` on first
  boot; never binds a public port (Cloudflare reaches it via Hyperdrive over a
  tunnel).
- **`redis`** — the indexer cursor + heartbeat mirror.
- **`subtensor`** — a pruned finney node (the head source + first-party RPC
  origin). For the one-time historical backfill, point the indexer at a transient
  archive source via `EVENTS_RPC_URL` / `START_BLOCK` / a raised
  `EVENTS_MAX_LOOKBACK`.
- **`indexer`** (`scripts/index-chain.py`) — follows the finalized head from the
  durable cursor and idempotently writes `blocks` / `extrinsics` /
  `account_events` into Postgres. Its pure transforms are unit-tested
  (`scripts/test_index_chain.py`); **verify ~100% capture vs D1 before any
  serving cutover** (the ADR 0013 gate).

To use **managed Railway Postgres** instead of the in-stack one (for managed
backups/HA), delete the `postgres` service and point the indexer's
`DATABASE_URL` at the Railway URL — the schema is portable and nothing else
changes.

## Provisioning Railway (only if NOT co-locating Postgres on bare metal)

> Idle managed Postgres/Redis bill from the moment they exist, and nothing reads
> them until the `indexer` lands. Provision as part of the indexer phase, not
> ahead of it. Run from a **dedicated directory** (NOT this repo) so this repo's
> Railway link state stays clean — `railway init` links the current dir.

```bash
mkdir -p ~/metagraphed-core && cd ~/metagraphed-core
railway init --name metagraphed-core --workspace aethereal --json
railway add -d postgres          # managed Postgres (enable TimescaleDB, or use the Timescale template)
railway add -d redis             # indexer cursor + dedup + queue
# apply the portable schema:
railway connect postgres < /path/to/metagraphed/deploy/postgres/schema.sql
```

Each compute service is added from the monorepo with its own root/Dockerfile and
cross-service variable references, e.g.:

```bash
railway add -s indexer --repo JSONbored/metagraphed --branch main \
  -v DATABASE_URL='${{Postgres.DATABASE_URL}}' \
  -v REDIS_URL='${{Redis.REDIS_URL}}' \
  -v EVENTS_RPC_URL='wss://entrypoint-finney.opentensor.ai:443'
```

Cron services (`rollups`, `exporter`, `reconciler`) get a crontab via the service
settings (run-and-terminate). Long-running services (`indexer`, `subtensor-node`,
`health-prober`, `alerter`) restart-on-failure with effectively-infinite retries
(a head-follower must retry forever) + a `last_ingested_block` heartbeat into
Redis so the Worker can surface "realtime stale".

## Cloudflare side

```bash
# Hyperdrive over a Cloudflared tunnel / Workers VPC to the Railway Postgres.
npx wrangler hyperdrive create metagraphed-core --connection-string "$POSTGRES_PRIVATE_URL"
# then add the [[hyperdrive]] binding to wrangler.jsonc and read via the binding.
```

The Durable Object firehose hub is a new binding in the Worker; the `indexer`
tees each decoded batch to it for SSE/WS/GraphQL-subscription fan-out.

## Gated steps — DO NOT run unsupervised

Each needs a human who can verify/roll back (ADR 0013 _Sequencing_):

1. **`subtensor-node`** — pruned (128 GB volume), follows head. (A permanent
   archive node is ~3.5 TB — avoided; backfill uses a transient archive source.)
2. **`indexer` + one-time backfill** — then **verify ~100 % capture vs D1**
   before trusting it.
3. **Serving cutover** — point the Worker at Hyperdrive→Postgres **tier by tier**
   (blocks → extrinsics → accounts → metagraph), D1 as fallback; only then delete
   the prune-and-discard logic.
4. **Decommission** the GitHub `*/5` poller (`refresh-events.yml`), the
   `metagraphed-streamer` project, and the `*/3` R2-staging drain; demote D1 to a
   hot cache.

## Backups (mandatory)

Postgres holds irreplaceable derived state (the node is restorable from chain).
Ship WAL/dumps to **R2** (zero-egress): a `pg_dump`/WAL job to an R2 bucket, or
Railway's managed backups + a periodic R2 export via the `exporter` service.
