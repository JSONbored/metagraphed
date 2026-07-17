# Box-side runner for metagraphed's first-party chain-direct fetch scripts
# (fetch-metagraph-native.py, fetch-account-identity.py,
# fetch-subnet-hyperparams.py, fetch-validator-nominator-counts.py) --
# replaces the GitHub Actions `fetch` job the first three previously ran in
# (refresh-metagraph.yml / refresh-account-identity.yml / refresh-subnet-
# hyperparams.yml, all retired); the fourth never had a GitHub Actions
# equivalent. Deliberately holds NO secrets and NO network egress beyond the
# chain RPC it's pointed at (plus GitHub, for the clone below): this is the
# untrusted half of the least-privilege split those workflows' own comments
# documented ("the unpinned PyPI execution boundary ... can only pass the
# JSON data artifact forward") -- the box's roles/data-refresh-cron systemd
# units run this container with only SUBTENSOR_RPC_URL (non-secret) in its
# env, then read the JSON it writes to a bind-mounted /out and do the
# authenticated Postgres sync themselves, as a separate step outside this
# container, exactly the same isolation the two GitHub Actions jobs gave
# (fetch job has zero secrets; sign-and-stage job starts from a fresh
# checkout and never runs this untrusted code).
#
# One generic image for all four scripts -- which one to run is a runtime
# argument (see scripts/metagraph-fetch-entrypoint.sh).
#
# Clones this repo at CONTAINER RUNTIME (entrypoint.sh) rather than baking
# the fetch scripts into the image at build time -- see the entrypoint's own
# header for why (a prior copy-based deployment in metagraphed-infra let
# real fixes silently go stale). This does NOT reintroduce the exact risk a
# 2026-07-14 security scan finding (P2) fixed: that finding was about
# `uvx --from bittensor==X.Y` re-resolving bittensor and its ~46 transitive
# dependencies FRESH from PyPI on every run with only a semver pin, NO hash
# verification at all. This entrypoint still runs `uv sync --locked` --
# hash-verified against uv.lock every single time, exactly like the old
# build-time-only install did -- just reading a freshly-cloned copy of that
# lock file instead of one baked into the image. The security property (no
# unpinned/unverified PyPI resolution, ever) is unchanged; only WHEN the
# verified install happens moved from image-build time to container-start
# time, matching data-refresh-node.Dockerfile's own established pattern for
# its own (npm-based) dependencies.
#
# Deployed the same way chain-firehose-relay/streamer are: the Ansible
# `data-refresh-cron` role in JSONbored/metagraphed-infra copies this
# Dockerfile + scripts/metagraph-fetch-entrypoint.sh into
# roles/data-refresh-cron/files/ and builds directly on the indexer box --
# but no longer copies the fetch scripts themselves, pyproject.toml, or
# uv.lock; those are cloned fresh at container start.
#
# Local:  docker build -f deploy/metagraph-fetch.Dockerfile -t metagraphed-data-refresh .
#
# uv comes from astral-sh's own official Docker image via a pinned-digest
# multi-stage COPY (their documented, recommended pattern for Dockerfiles) --
# NOT curl|sh, which a security scan correctly flagged as an unverified
# remote-installer execution (2026-07-13).
FROM ghcr.io/astral-sh/uv:0.11.28@sha256:0f36cb9361a3346885ca3677e3767016687b5a170c1a6b88465ec14aefec90aa AS uv
# Pin both the semantic Python/Debian version and the OCI index digest so the
# fetch image has no mutable base-image input. When bumping Python, update the
# tag and digest together (Docker Hub lists this index digest for
# python:3.12.11-slim-bookworm).
FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7
COPY --from=uv /uv /uvx /usr/local/bin/
# git: needed for the runtime clone. ca-certificates: needed for both the
# HTTPS clone and the chain RPC / Postgres-sync HTTPS calls the fetch
# scripts themselves make.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -u 10001 -m fetcher \
  && mkdir -p /repo \
  && chown fetcher:fetcher /repo
WORKDIR /app

COPY scripts/metagraph-fetch-entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER fetcher
# Provide at runtime: SCRIPT (one of fetch-metagraph-native.py /
# fetch-account-identity.py / fetch-subnet-hyperparams.py /
# fetch-validator-nominator-counts.py), SUBTENSOR_RPC_URL (non-secret -- our
# own fullnode's tailnet address), optionally SENTRY_DSN/SENTRY_ENVIRONMENT
# (silently no-op if unset -- see scripts/observability.py), and whichever
# *_JSON output-path env var(s) the target script reads (see each script's
# own OUT/module-level constant(s)). Mount /out for the result(s) and /repo
# as a persistent volume (so the entrypoint's git clone + uv sync are only
# paid in full on the FIRST run against a given volume, not every
# daily/weekly cron tick).
ENTRYPOINT ["./entrypoint.sh"]
