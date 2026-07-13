# Box-side runner for metagraphed's first-party chain-direct fetch scripts
# (fetch-metagraph-native.py, fetch-account-identity.py,
# fetch-subnet-hyperparams.py) -- replaces the GitHub Actions `fetch` job
# these three previously ran in (refresh-metagraph.yml / refresh-account-
# identity.yml / refresh-subnet-hyperparams.yml, all retired). Deliberately
# holds NO secrets and NO network egress beyond the chain RPC it's pointed
# at: this is the untrusted half of the least-privilege split those
# workflows' own comments documented ("the unpinned PyPI execution boundary
# ... can only pass the JSON data artifact forward") -- the box's
# roles/data-refresh-cron systemd units run this container with only
# SUBTENSOR_RPC_URL (non-secret) in its env, then read the JSON it writes to
# a bind-mounted /out and do the authenticated Postgres sync themselves, as a
# separate step outside this container, exactly the same isolation the two
# GitHub Actions jobs gave (fetch job has zero secrets; sign-and-stage job
# starts from a fresh checkout and never runs this untrusted code).
#
# One generic image for all three scripts -- which one to run and which
# pinned bittensor SDK version to fetch (uv resolves it fresh each run, not
# baked into the image) are both runtime arguments, matching each script's
# own GitHub Actions invocation exactly (see entrypoint.sh).
#
# Deployed the same way chain-firehose-relay/streamer are: the Ansible
# `data-refresh-cron` role in JSONbored/metagraphed-infra copies this
# Dockerfile + the three scripts into roles/data-refresh-cron/files/ and
# builds directly on the indexer box. Re-run that role after updating any of
# the four files to rebuild with the latest fix.
#
# Local:  docker build -f deploy/metagraph-fetch.Dockerfile -t metagraphed-data-refresh .
#
# uv comes from astral-sh's own official Docker image via a pinned-digest
# multi-stage COPY (their documented, recommended pattern for Dockerfiles) --
# NOT curl|sh, which a security scan correctly flagged as an unverified
# remote-installer execution (2026-07-13).
FROM ghcr.io/astral-sh/uv:0.11.28@sha256:0f36cb9361a3346885ca3677e3767016687b5a170c1a6b88465ec14aefec90aa AS uv
# python:3.12-slim is a mutable tag, not digest-pinned -- matches this repo's
# existing convention (deploy/chain-firehose-relay.Dockerfile's node:22.23.1-
# alpine is the same shape); not switching just this one Dockerfile to a
# digest would be inconsistent, not more secure.
FROM python:3.12-slim
COPY --from=uv /uv /uvx /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -u 10001 -m fetcher
WORKDIR /app

COPY scripts/fetch-metagraph-native.py ./scripts/fetch-metagraph-native.py
COPY scripts/fetch-account-identity.py ./scripts/fetch-account-identity.py
COPY scripts/fetch-subnet-hyperparams.py ./scripts/fetch-subnet-hyperparams.py
COPY scripts/metagraph-fetch-entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh && chown -R fetcher:fetcher /app

ENV UV_CACHE_DIR=/app/.uv-cache
RUN mkdir -p /app/.uv-cache && chown -R fetcher:fetcher /app/.uv-cache

USER fetcher
# Provide at runtime: SCRIPT (one of fetch-metagraph-native.py /
# fetch-account-identity.py / fetch-subnet-hyperparams.py), BITTENSOR_VERSION,
# SUBTENSOR_RPC_URL (non-secret -- our own fullnode's tailnet address), and
# whichever *_JSON output-path env var the target script reads (see each
# script's own OUT/module-level constant). Mount /out for the result.
ENTRYPOINT ["./entrypoint.sh"]
