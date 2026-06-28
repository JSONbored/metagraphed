# Serving cutover: D1 → Postgres via Cloudflare Hyperdrive (ADR 0013)

The final, **gated** phase: point the Cloudflare Worker at the indexer's Postgres
through Hyperdrive, **tier by tier, with D1 as fallback**. The indexer already
captures into Postgres; this is what makes the public API _serve_ from it.

> **DO NOT start until the indexer is verified ~100% capture vs D1** (step 0).
> Each step is reversible per-tier. Run with a human watching.

## 0. Gate — prove capture before touching serving

Compare Postgres vs D1 over a recent window, per tier. Only cut a tier when
Postgres ≥ D1 for that tier across the window (and spot-check a few rows match):

```sql
-- Postgres (railway connect Postgres / psql):
SELECT count(*) FROM blocks         WHERE block_number > <head-10000>;
SELECT count(*) FROM extrinsics     WHERE block_number > <head-10000>;
SELECT count(*) FROM account_events WHERE block_number > <head-10000>;
```

Compare against the equivalent D1 counts. Investigate any shortfall before
proceeding — a gap here becomes a serving regression.

## 1. Expose Postgres to Cloudflare privately (Tunnel + Workers VPC)

Postgres must **never** be public. Use the recommended private-DB path — a
Cloudflare Tunnel fronted by a **Workers VPC** service (Hyperdrive auto-creates
the Access app + service token):

On the box (where Postgres listens on localhost:5432):

```bash
cloudflared tunnel login
cloudflared tunnel create metagraphed-pg
# route the tunnel to Postgres (TCP) and run it (systemd unit in prod):
cloudflared tunnel run metagraphed-pg
```

Then create a **Workers VPC service** over that tunnel — dashboard:
_Hyperdrive → Connect to private database → Workers VPC →_ pick the tunnel, enter
the origin host + TCP port (`localhost:5432`). (VPC services are reusable across
Hyperdrive configs and bindable to Workers directly.)

## 2. Create the Hyperdrive config (Workers VPC-backed)

Use the Cloudflare dashboard to create the Hyperdrive config: _Workers & Pages →
Hyperdrive → Create configuration → Connect to private database → Workers VPC_,
select `<VPC_SERVICE_ID>`, then enter the database name (`metagraphed`), user
(`metagraphed`), password, and PostgreSQL scheme in the dashboard form. Do **not**
put the database password in a `wrangler hyperdrive create --password ...` command
or any other shell-expanded argument; command lines can be recorded in shell
history, process listings, terminal logs, and CI logs.

The dashboard returns a Hyperdrive **id**. (Hyperdrive pools connections + caches
reads at the edge, so the Worker isn't opening a fresh cross-network connection
per request.)

## 3. Bind it in the Worker

`wrangler.jsonc`:

```jsonc
"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<HYPERDRIVE_ID>" }]
```

Read with a Workers-compatible Postgres driver (`postgres` / `pg`) via
`env.HYPERDRIVE.connectionString`. Keep reads parameterized + read-only.

## 4. Cut over tier by tier (D1 fallback)

For each serving tier in order — **blocks → extrinsics → account_events →
metagraph** — move that tier's read from D1 to Postgres behind a flag, keep D1 as
the fallback, deploy, and watch latency + correctness before the next tier:

```
read(tier):
  if FLAG[tier] == "postgres":  try Postgres (Hyperdrive); on error → D1
  else:                          D1
```

Leave the indexer's Postgres writes **and** the D1 write/prune paths running until
every tier is cut and stable (dual-write during migration).

## 5. Rollback

Per-tier flag → flip the tier back to D1 if it misbehaves. Hyperdrive caches
reads; account for cache staleness on schema changes (recreate the config).

## 6. After full cutover (decommission — the last gated step)

Only once **all** tiers serve from Postgres and are stable:

1. **Delete** the `metagraphed-streamer` project (now superseded — it fed D1).
2. **Decommission** the GitHub `*/5` poller (`refresh-events.yml`) + the `*/3`
   R2-staging drain.
3. **Demote D1** to a hot cache, or retire it.
4. Optionally **add the box's node to the RPC/WSS pools** so `/rpc/v1` +
   `wss.metagraph.sh` can route to first-party infra.
