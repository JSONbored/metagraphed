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

| Tier          | Where                                                     | Pieces                                                                                                                                                                                                                                                           |
| ------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge (rented) | **Cloudflare**                                            | Worker serving, **Hyperdrive** → Postgres, **Durable Object** firehose, R2, KV, Vectorize, Workers AI, rate-limiters, RPC proxy                                                                                                                                  |
| Core (owned)  | **Dedicated box** (data plane) + **Railway** (light glue) | box: `subtensor-node` (**full archive**, ~3.5 TB+ NVMe) + `postgres` + `redis` + `indexer`; Railway: `wss-lb` + crons (`health-prober`, `rollups`, `alerter`, `exporter`, `reconciler`). _Interim: Postgres/Redis/indexer run on Railway until the box is live._ |
| Escape hatch  | **Hetzner** (later)                                       | `postgres` (+ optional node) when compressed history > ~300–500 GB or the 1 TB Railway cap looms — see ADR 0013                                                                                                                                                  |

One Railway **project**, two **environments** (`production`, `staging`), one
private network (`<service>.railway.internal`, zero egress). The existing
`metagraphed-streamer` project is **separate and untouched** — it is superseded
by `indexer` only at decommission (final step).

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
  - `metagraphed-streamer` → `/railway.json`
  - `wss-lb` → `/deploy/wss-lb/railway.json`
  - `indexer` → `/deploy/indexer.railway.json`

  Each builds its Dockerfile from the **repo-root** build context (leave Root
  Directory unset) and scopes redeploys with `watchPatterns`, so a streamer change
  never rebuilds the indexer.

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

- **`postgres`** (TimescaleDB) — applies `deploy/postgres/schema.sql` on first
  boot; never binds a public port (Cloudflare reaches it via Hyperdrive over a
  tunnel).
- **`redis`** — the indexer cursor + heartbeat mirror.
- **`subtensor`** — a **full archive** finney node (`--pruning=archive --sync=full`:
  complete state from genesis), the head source + first-party RPC origin + the
  indexer's self-sufficient backfill source. Needs **~8 TB+ NVMe**; the from-genesis
  full sync takes days, so seed the volume from an opentensor archive snapshot when
  available. (Dev: `SUBTENSOR_PRUNING=2000 SUBTENSOR_SYNC=warp` for a small pruned
  node; deep backfill then comes from the public archive via `EVENTS_RPC_URL`.)
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

The whole project bring-up is scripted in [`railway-bootstrap.sh`](railway-bootstrap.sh)
— the canonical, version-controlled record of the topology (run it once against a
fresh project to recreate prod or stand up `staging`, so it is never assembled by
hand). The commands below are that script, annotated.

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
  -v EVENTS_RPC_URL='wss://bittensor-finney.api.onfinality.io/public-ws'   # WS archive, NOT pruned entrypoint
```

The public `wss-lb` is independent of Postgres/Redis (it reads only the public
API), so it can ship **first**, before any DB exists:

```bash
railway add -s wss-lb --repo JSONbored/metagraphed --branch main
# set its Config File = /deploy/wss-lb/railway.json (dashboard), then expose it:
railway domain
```

Cron services (`rollups`, `exporter`, `reconciler`) get a crontab via the service
settings (run-and-terminate). Long-running services (`indexer`, `subtensor-node`,
`health-prober`, `alerter`) restart-on-failure with effectively-infinite retries
(a head-follower must retry forever) + a `last_ingested_block` heartbeat into
Redis so the Worker can surface "realtime stale".

## Cloudflare side

The full, gated **serving cutover** (D1 → Postgres via Hyperdrive over a Tunnel +
Workers VPC, tier-by-tier with D1 fallback) is its own runbook:
[`hyperdrive-cutover.md`](hyperdrive-cutover.md). In short:

```bash
# Workers VPC over a Cloudflare Tunnel to the private Postgres (box or Railway):
npx wrangler hyperdrive create metagraphed-core --service-id <VPC_SERVICE_ID> \
  --database metagraphed --user metagraphed --password <PW> --scheme postgresql
# then add the [[hyperdrive]] binding to wrangler.jsonc and read via the binding.
```

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
4. **Decommission** the GitHub `*/5` poller (`refresh-events.yml`), the
   `metagraphed-streamer` project, and the `*/3` R2-staging drain; demote D1 to a
   hot cache.

## Backups + PITR (mandatory)

Postgres holds derived state. It is **re-derivable** (re-index from the chain via
the archive node), but a full re-index is slow — so back it up; you just don't
need a near-zero RPO.

- **Enable Railway scheduled backups — daily.** Cheap insurance. Railway bills a
  backup at the **incremental size, per GB-minute**, so daily snapshots of a
  compressing DB add only a modest fraction on top of the volume cost.
- **Full continuous PITR is optional / overkill here.** PITR buys a seconds-level
  RPO via continuous WAL — worth it for un-recreatable OLTP data, but our worst
  case is "re-index the last day from chain," which a daily snapshot already
  bounds. It also adds WAL-storage cost. Skip it unless the re-index window
  becomes painful; daily snapshots + the R2 export below are enough.
- **Cheapest durable copy: `pg_dump` → R2** (zero-egress) via the `exporter`
  service on a schedule — the long-term archive, independent of Railway.

Whichever you pick, the DB volume + backups are the storage-cost driver; when they
outgrow Railway economics, that is the trigger for the Hetzner escape hatch
(TimescaleDB compression ~10–20×) in ADR 0013.
