# Box-side relay for the realtime chain-event firehose (#4981, #5027, ADR
# 0015). A tiny always-on process: polls/claims pending rows from the box's
# own Postgres chain_firehose_outbox table, forwards each to the Cloudflare
# Durable Object ingest endpoint (#4982). Only ever UPDATEs rows it has
# itself claimed, never in indexer-rs's critical path -- see
# scripts/chain-firehose-relay.ts's own header comment for why this is safe
# by construction, unlike the retired streamer (docs/adr/0014).
#
# Clone-at-runtime, like metagraph-fetch.Dockerfile/data-refresh-node.Dockerfile
# /economics-refresh.Dockerfile: this image holds no copy of
# chain-firehose-relay.ts itself (see scripts/chain-firehose-relay-entrypoint.sh).
# metagraphed-infra used to track a second, independently-drifting copy of
# this file (metagraphed#6451); the entrypoint now clones the real one from
# GitHub at container start instead. The Ansible `chain-firehose-relay` role
# in JSONbored/metagraphed-infra now copies only this Dockerfile + the
# entrypoint script into roles/chain-firehose-relay/files/ and builds
# directly on the indexer box. Restarting the container (not rebuilding the
# image) is enough to pick up the latest main.
#
# Local:  docker build -f deploy/chain-firehose-relay.Dockerfile -t metagraphed-chain-firehose-relay .
FROM node:22.23.1-alpine
RUN apk add --no-cache bash git ca-certificates
# BusyBox adduser (Alpine's) -- -D skips setting a password, -u pins the uid.
RUN adduser -D -u 10001 relay
WORKDIR /app

COPY --chown=relay:relay scripts/chain-firehose-relay-entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV NODE_ENV=production

USER relay
# Provide at runtime (NOT baked in): DATABASE_URL, CHAIN_FIREHOSE_SYNC_SECRET,
# and optionally CHAIN_FIREHOSE_INGEST_URL (defaults to the production hub),
# SENTRY_DSN, SENTRY_RELEASE (auto-derived from the freshly-cloned HEAD if
# unset).
ENTRYPOINT ["./entrypoint.sh"]

# metagraphed-infra#63: this relay previously had zero monitoring coverage --
# a dead poll loop could go unnoticed indefinitely since Docker's own
# "Running" state only means the process hasn't exited, not that it's doing
# anything useful. --healthcheck reads HEARTBEAT_FILE's mtime (see the
# script's own comment on that constant) -- unhealthy once no poll iteration
# has completed in HEARTBEAT_STALE_MS. start-period covers the real startup
# path (the entrypoint's clone + npm ci, both quick, but generous margin
# costs nothing here). /tmp/repo is a FIXED path the entrypoint always clones
# into (see its own comment for why that's safe here) -- this HEALTHCHECK
# CMD is baked into the image at build time and has no other way to find the
# script. metagraphed-infra's docker-container-health-poll.sh (that role)
# turns `docker inspect`'s resulting health status into a Prometheus-visible
# metric -- Docker's HEALTHCHECK alone has no alerting of its own.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "/tmp/repo/scripts/chain-firehose-relay.ts", "--healthcheck"]
