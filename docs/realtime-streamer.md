# Realtime chain-event streamer (Option B)

The CI poller (#1346) + the `*/3` Worker load cron (#1359) give ~5-minute
chain-event freshness for **$0** — but GitHub's scheduled-cron is best-effort and
can be delayed for hours. For **true ~12-second realtime**, run the persistent
streamer (#1361): a tiny always-on process that subscribes to finalized finney
heads, decodes each block, and pushes the events to the Worker ingest endpoint
(#1360). The CI poller stays on as a self-healing backstop — inserts are
idempotent on `(block_number, event_index)`, so any overlap is free.

This needs one small always-on host (**~$0–5/mo**): Oracle Cloud Free Tier or
Fly.io's free allowance ($0), or a cheap VPS / Railway / Render worker (~$5/mo).

## Deployed on Railway (current)

This project runs the streamer on Railway (project `metagraphed-streamer`). Cost is
**RAM-dominated** — the streamer idles on a WebSocket between blocks, so CPU is
near-zero; realistically **~$1.5/mo** (~150 MB held 24/7) on usage-based billing.

Config is **config-as-code in `railway.json`** (build via `deploy/streamer.Dockerfile`,
`ON_FAILURE` restart capped at 10 retries, and `watchPatterns` so a GitHub-connected
deploy only rebuilds when the streamer's own files change — important because this
repo's `main` is very active). To enable auto-deploys like the Cloudflare Workers
Builds pipeline: **Service → Settings → Connect Repo** → `JSONbored/metagraphed`,
branch `main`. The watch paths in `railway.json` keep unrelated merges from
triggering pointless rebuilds.

**Cost caps (set once, so the bill can't balloon):**

- **Service → Settings → Scale → Replica Limits:** drop Memory to ~512 MB (the
  streamer uses ~150 MB; this hard-caps the per-service cost). CPU can stay/at ~2 vCPU.
- **Workspace → Settings → Usage:** set an account usage limit (hard stop) at your
  comfort threshold. Note it's shared with other services (e.g. Umami), so size it to
  cover both — Railway pauses services if the limit is hit.

## 1. Configure the Worker secret (one-time)

The ingest endpoint is disabled until the secret is set. Generate a strong token
and add it as a Worker secret:

```sh
openssl rand -hex 32                       # generate a token
npx wrangler secret put METAGRAPH_EVENTS_INGEST_SECRET   # paste it
```

Until this is set, `POST /api/v1/internal/events` returns `503` (safe default).

## 2. Run the streamer with the same token

### Docker (any host)

```sh
docker build -f deploy/streamer.Dockerfile -t metagraphed-streamer .
docker run --restart=always \
  -e EVENTS_INGEST_URL=https://api.metagraph.sh/api/v1/internal/events \
  -e METAGRAPH_EVENTS_INGEST_SECRET=<the same token> \
  metagraphed-streamer
```

### systemd (a VPS, no Docker)

```ini
# /etc/systemd/system/metagraphed-streamer.service
[Unit]
Description=metagraphed realtime chain-event streamer
After=network-online.target

[Service]
Environment=EVENTS_INGEST_URL=https://api.metagraph.sh/api/v1/internal/events
Environment=METAGRAPH_EVENTS_INGEST_SECRET=<the same token>
ExecStart=/usr/bin/uv run --with substrate-interface==1.8.1 python /opt/metagraphed/scripts/stream-events.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## How it works

`scripts/stream-events.py` reuses the **exact verified decode** from
`scripts/fetch-events.py` (imported, not duplicated). On each finalized head it
decodes the SubtensorModule events and `POST`s them to the ingest endpoint with
the `x-metagraph-events-token` header; the Worker writes them to the
`account_events` D1 tier with the same parameterized `INSERT OR IGNORE` as the
batch loader. It auto-reconnects on RPC drops.

## Cost & reliability

- **$0–5/mo** depending on host (free tiers exist).
- ~12–30s latency (one block behind the chain).
- If the streamer is down, the CI poller backfills the gap on its next run — no
  data loss, just temporary staleness.
- Deep historical backfill (before launch) is a separate decision (#1349).
