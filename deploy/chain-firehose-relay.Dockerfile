# Box-side relay for the realtime chain-event firehose (#4981, #5027, ADR
# 0015). A tiny always-on process: polls/claims pending rows from the box's
# own Postgres chain_firehose_outbox table, forwards each to the Cloudflare
# Durable Object ingest endpoint (#4982). Only ever UPDATEs rows it has
# itself claimed, never in indexer-rs's critical path -- see
# scripts/chain-firehose-relay.mjs's own header comment for why this is safe
# by construction, unlike the retired streamer (docs/adr/0014).
#
# Deployed the same way the (also retired) metagraphed-streamer was: the
# Ansible `chain-firehose-relay` role in JSONbored/metagraphed-infra copies
# this Dockerfile + scripts/chain-firehose-relay.mjs into
# roles/chain-firehose-relay/files/ and builds directly on the indexer box
# (no cross-compilation concern -- this is a single small ESM file + one npm
# dependency). Re-run that role after updating either file to rebuild with
# the latest fix.
#
# Local:  docker build -f deploy/chain-firehose-relay.Dockerfile -t metagraphed-chain-firehose-relay .
FROM node:22.23.1-alpine
# BusyBox adduser (Alpine's) -- -D skips setting a password, -u pins the uid.
RUN adduser -D -u 10001 relay
WORKDIR /app

# Pinned dependencies (postgres.js matches the root package.json's own pin,
# the same driver workers/data-api.mjs uses) -- never auto-pull a future
# release independently of the rest of the repo. @sentry/node also matches
# the root package.json pin.
RUN npm install --no-audit --no-fund postgres@3.4.9 @sentry/node@10.66.0

COPY scripts/chain-firehose-relay.mjs ./scripts/chain-firehose-relay.mjs

ENV NODE_ENV=production

USER relay
# Provide at runtime (NOT baked in): DATABASE_URL, CHAIN_FIREHOSE_SYNC_SECRET,
# and optionally CHAIN_FIREHOSE_INGEST_URL (defaults to the production hub).
CMD ["node", "scripts/chain-firehose-relay.mjs"]
