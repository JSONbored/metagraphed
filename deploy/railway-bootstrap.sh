#!/usr/bin/env bash
# Reproducible bring-up of the Railway **metagraphed-core** project (ADR 0013).
#
# This is the canonical, version-controlled record of how the project is built —
# run it against a FRESH project (e.g. to recreate prod, or stand up `staging`)
# so the topology is never assembled by hand again. It is NOT idempotent: each
# `railway add` creates a new service, so run it once per fresh project.
#
# Ongoing per-service build/deploy config is already code (the committed
# railway.json files); this script captures the one-time PROJECT topology
# (services, managed DBs, cross-service variable references, the public domain).
#
# Prereqs: authenticated Railway CLI (`railway whoami`), run from a DEDICATED dir
# (NOT this repo — `railway init` links the CWD):
#   mkdir -p ~/metagraphed-core && cd ~/metagraphed-core && bash /path/to/repo/deploy/railway-bootstrap.sh
set -euo pipefail

REPO="JSONbored/metagraphed"
BRANCH="main"
WORKSPACE="aethereal"
# ARCHIVE endpoint — the indexer backfills old-block state, which pruned nodes
# (entrypoint-finney) discard ("State already discarded"). On the box this points
# at the local archive node instead.
RPC_URL="${EVENTS_RPC_URL:-wss://archive.chain.opentensor.ai:443}"

echo "==> 1. Create the project + default (production) environment"
railway init --name metagraphed-core --workspace "$WORKSPACE" --json

echo "==> 2. Managed databases (private only — never expose a public domain on these)"
railway add -d postgres     # → ${{Postgres.DATABASE_URL}}, host postgres.railway.internal
railway add -d redis        # → ${{Redis.REDIS_URL}},     host redis.railway.internal

echo "==> 3. Public WSS load balancer (the ONLY service that gets a public domain)"
railway add -s wss-lb --repo "$REPO" --branch "$BRANCH"
#   then in the dashboard: Settings → Config-as-code → Railway Config File =
#   /deploy/wss-lb/railway.json   (absolute; it does not follow Root Directory)
railway domain                # mint *.up.railway.app; add a CNAME for wss.metagraph.sh

echo "==> 4. Indexer (private; references the DBs over the private network)"
railway add -s indexer --repo "$REPO" --branch "$BRANCH" \
  -v "DATABASE_URL=\${{Postgres.DATABASE_URL}}" \
  -v "REDIS_URL=\${{Redis.REDIS_URL}}" \
  -v "EVENTS_RPC_URL=${RPC_URL}"
#   then in the dashboard: Config-as-code → Railway Config File =
#   /deploy/indexer.railway.json

echo "==> 5. Apply the portable schema to Postgres (one-time, before the indexer runs)"
#   psql against the PUBLIC proxy URL (the private host isn't reachable from your laptop):
#   PGURL=$(railway variables -s Postgres --kv | sed -n 's/^DATABASE_PUBLIC_URL=//p')
#   psql "$PGURL" -f /path/to/repo/deploy/postgres/schema.sql
echo "    (see the commented psql line above — needs the repo's deploy/postgres/schema.sql)"

cat <<'NOTE'

==> Manual one-time toggles the CLI can't set (dashboard, per service):
  - Config-as-code "Railway Config File" path (wss-lb, indexer) — see steps 3/4.
  - Feature-flags → Skipped Builds: ON for wss-lb + indexer (build cache; no downside).
  - Deploy → Serverless: OFF for wss-lb + indexer (always-on; serverless drops WS).
  - Postgres → scheduled backups (daily) — derived state insurance (see deploy/README.md).
Everything else (builder, watch paths, healthcheck, restart policy, replicas) comes
from the committed railway.json on first deploy.
NOTE
