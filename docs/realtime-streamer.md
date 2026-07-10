# Realtime chain-event streamer (Option B) — STOPPED 2026-07-10

**Stopped, not deleted** (`docker stop metagraphed-streamer` on the indexer
box; `unless-stopped` restart policy means it stays stopped). Its only
purpose was keeping D1 fresh in real time as a second, independent
live-following pipeline alongside `indexer-rs` (the actual source of truth,
writing to Postgres). Now that `METAGRAPH_BLOCKS_SOURCE`,
`METAGRAPH_EXTRINSICS_SOURCE`, and `METAGRAPH_ACCOUNT_EVENTS_SOURCE` all read
`"postgres"` (ADR 0014), running two independent live indexers to two
different databases was exactly the duplication/drift risk ADR 0014 called
out — one first-party live indexer (`indexer-rs`) is enough. D1's data is now
frozen at whatever it held when the streamer stopped, and will shrink on its
own as `pruneBlocks`/`pruneExtrinsics`/`pruneAccountEvents` age it out (30d /
5d / 3d retention respectively) — no further action needed to wind it down.
The rest of this doc describes how the streamer worked while it was running,
kept for history; don't restart it without re-reading ADR 0014 first.

A tiny always-on process (#1361) subscribes to finalized finney heads, decodes
each block, and pushes the events to the Worker ingest endpoint (#1360) — true
~12-second realtime freshness. Inserts are idempotent on
`(block_number, event_index)`, so any overlap with another source is free.

## Deployed on the self-hosted indexer box

The streamer runs via the `streamer` Ansible role (see
[`JSONbored/metagraphed-infra`](https://github.com/JSONbored/metagraphed-infra),
`roles/streamer/`) on `meta-indexer-01-us-lax1` — Docker built directly on the
box from a static copy of this repo's `scripts/{fetch-events,stream-events}.py`.
It previously ran on Railway (project `metagraphed-streamer`); that project has
been deleted (2026-07-04) now that the self-hosted deployment is verified
stable — moving it off Railway removed a recurring cost with no functional
change.

## 1. Configure the Worker secret (one-time)

The ingest endpoint is disabled until the secret is set. Generate a strong token
and add it as a Worker secret:

```sh
openssl rand -hex 32                       # generate a token
npx wrangler secret put METAGRAPH_EVENTS_INGEST_SECRET   # paste it
```

Until this is set, `POST /api/v1/internal/events` returns `503` (safe default).

## 2. Run the streamer with the same token

### Ansible (the canonical deployment — see metagraphed-infra's `roles/streamer/`)

Builds the Dockerfile directly on the target box from a static copy of this
repo's `scripts/{fetch-events,stream-events}.py`; re-run the role after
updating those files upstream to pick up the change (it doesn't track this repo
live).

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

- Runs on already-paid-for self-hosted capacity — no incremental hosting cost.
- ~12–30s latency (one block behind the chain).
- If the streamer is down, there is **no automatic backstop** (the GitHub
  Actions poller that used to cover this, `refresh-events.yml`, was retired
  2026-07-04 — redundant with the streamer's own reliability once self-hosted).
  Gap recovery is a manual `backfill-events.yml` rerun for the affected range.
- Deep historical backfill (before launch) is a separate decision (#1349).
