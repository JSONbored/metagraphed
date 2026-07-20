# Box-side runner for the live economics KV refresh (#1009 follow-up,
# replaces .github/workflows/refresh-economics.yml). Unlike
# deploy/metagraph-fetch.Dockerfile's narrow single-purpose containers, this
# job also needs registry/subnets/*.json -- git-committed curated data that
# changes via contributor PRs and must stay reasonably fresh -- so the repo
# checkout is refreshed at CONTAINER RUNTIME (git pull, see
# scripts/economics-refresh-entrypoint.sh), not frozen at image-build time
# the way the fetch scripts' bittensor pin is.
#
# Same least-privilege split as the other box jobs, preserved across TWO
# separate `docker run` invocations of this one image instead of one:
#   STEP=snapshot   -- runs scripts/refresh-native-snapshot.mjs, which shells
#                       out to `uvx --from bittensor==X.Y` (unpinned PyPI
#                       resolution at runtime, matching this exact codepath's
#                       existing GitHub Actions behavior -- not hash-locked
#                       yet like the other fetch scripts were, tracked as a
#                       follow-up). Gets ONLY SUBTENSOR_RPC_URL (non-secret).
#   STEP=economics  -- runs scripts/refresh-economics.mjs --write (pure JS,
#                       no PyPI/uvx involved). Gets the real
#                       CLOUDFLARE_API_TOKEN. Runs AFTER the snapshot step,
#                       reading the file it wrote from the same shared
#                       volume -- the untrusted-PyPI step and the
#                       secret-holding step never share a process.
# Both steps mount the SAME persistent named volume at /repo (a git
# checkout + node_modules, kept warm across runs) -- see
# roles/data-refresh-economics/files/refresh-economics.sh in
# metagraphed-infra for the orchestration.
#
# Non-root (uid 10001, matching metagraph-fetch.Dockerfile/chain-firehose-
# relay.Dockerfile's own convention). Originally shipped without one on the
# theory that this container accepts no external network input -- a security
# review correctly called that out as reasoning about the wrong risk: the
# real exposure isn't inbound network requests, it's SUPPLY CHAIN (npm ci's
# postinstall scripts across ~600 packages, the unpinned-at-runtime bittensor
# PyPI resolution noted above, in principle a compromised git ref) running
# arbitrary code -- and root privilege inside the container widens the blast
# radius of a container escape regardless of whether the process itself
# listens on a socket. /repo is pre-created + chowned here (not left for
# Docker to auto-create on first volume mount) so the entrypoint's runtime
# git clone/npm ci -- which must run as this same non-root user -- can
# actually write to it.
#
# Deployed via the data-refresh-economics Ansible role in
# JSONbored/metagraphed-infra, which copies this Dockerfile +
# scripts/economics-refresh-entrypoint.sh into
# roles/data-refresh-economics/files/ and builds directly on the indexer box.
#
# Local: docker build -f deploy/economics-refresh.Dockerfile -t metagraphed-data-refresh-economics .
#
# Debian (glibc), NOT Alpine (musl) -- matches metagraph-fetch.Dockerfile's
# own python:3.12-slim base. bittensor's bittensor-drand dependency ships
# manylinux (glibc) wheels only; on musl, uv falls back to a from-source
# build that needs a full Rust/cargo toolchain (confirmed by hitting this
# directly: `error: linker \`cc\` not found` compiling bittensor-drand's
# pyo3 extension under node:22-alpine). Debian's glibc gets the prebuilt
# wheel, no compiler needed, matching the already-proven fetch image.
FROM ghcr.io/astral-sh/uv:0.11.29@sha256:eb2843a1e56fd9e30c7276ce1a52cba86e64c7b385f5e3279a0e08e02dd058fc AS uv
FROM node:22.23.1-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/

RUN useradd -u 10001 -m runner \
  && mkdir -p /repo \
  && chown runner:runner /repo

COPY scripts/economics-refresh-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER runner
ENTRYPOINT ["/entrypoint.sh"]
