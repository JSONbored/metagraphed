# Box-side runner for the Node-only, no-chain-RPC data-refresh jobs:
# registry-sync (replaces .github/workflows/resync-registry-postgres.yml)
# and testnet-discovery (replaces
# .github/workflows/discover-testnet-surfaces.yml). Neither job needs
# Python/uv/bittensor -- unlike deploy/economics-refresh.Dockerfile, this is
# pure Node + git, so a single container per run is enough (no untrusted-
# PyPI-resolution step to isolate from a secret-holding step): npm ci
# --ignore-scripts + a tracked-file integrity check (see
# scripts/data-refresh-node-entrypoint.sh) is the supply-chain guard,
# applied from the start rather than as a follow-up fix.
#
# Non-root (uid 10001, matching metagraph-fetch.Dockerfile/chain-firehose-
# relay.Dockerfile/economics-refresh.Dockerfile's own convention). /repo is
# pre-created + chowned here so the entrypoint's runtime git clone/npm ci
# (which runs as this same non-root user) can write to it.
#
# Deployed via the data-refresh-node Ansible role in
# JSONbored/metagraphed-infra, which copies this Dockerfile +
# scripts/data-refresh-node-entrypoint.sh into
# roles/data-refresh-node/files/ and builds directly on the indexer box.
#
# Local: docker build -f deploy/data-refresh-node.Dockerfile -t metagraphed-data-refresh-node .
FROM node:22.23.1-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -u 10001 -m runner \
  && mkdir -p /repo \
  && chown runner:runner /repo

COPY scripts/data-refresh-node-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER runner
ENTRYPOINT ["/entrypoint.sh"]
