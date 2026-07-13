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
# One generic image for all three scripts -- which one to run is a runtime
# argument (see entrypoint.sh). bittensor is pinned to a SINGLE version
# (10.5.0) for all three: verified 2026-07-14 that fetch-metagraph-native.py
# and fetch-account-identity.py's entire API surface (get_all_metagraphs_info/
# MetagraphInfo) is byte-identical between bittensor 10.4.0 and 10.5.0 (the
# versions the 3 source GitHub Actions workflows used to split across) --
# fetch-subnet-hyperparams.py is the one that genuinely needs 10.5.0 (#4973,
# certain SubnetHyperparameters fields are silently unreadable under 10.4.0),
# so unifying costs nothing and simplifies this image to one locked venv.
#
# Deployed the same way chain-firehose-relay/streamer are: the Ansible
# `data-refresh-cron` role in JSONbored/metagraphed-infra copies this
# Dockerfile + scripts/pyproject.toml + scripts/uv.lock + the three scripts
# into roles/data-refresh-cron/files/ and builds directly on the indexer box.
# Re-run that role after updating any of these files to rebuild with the
# latest fix. To bump the pinned bittensor version: edit scripts/pyproject.toml,
# run `cd scripts && uv lock`, commit the updated scripts/uv.lock.
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
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -u 10001 -m fetcher
WORKDIR /app

# Hash-locked dependency install at BUILD time, not runtime -- a security scan
# correctly flagged the earlier `uvx --from bittensor==X.Y` pattern (2026-07-14,
# P2): it re-resolved bittensor and its ~46 transitive dependencies from PyPI
# fresh on EVERY container run with only a semver pin, no hash verification, so
# a compromised release at that exact version (or any transitive dependency)
# could execute inside this container on every fetch. `uv sync --locked`
# verifies every artifact against uv.lock's embedded hashes and FAILS THE
# BUILD on any mismatch -- verification happens once, at `docker build`, and
# the resulting venv is baked into the image; no PyPI resolution happens at
# container runtime anymore.
COPY scripts/pyproject.toml scripts/uv.lock ./
RUN uv sync --locked

COPY scripts/fetch-metagraph-native.py ./scripts/fetch-metagraph-native.py
COPY scripts/fetch-account-identity.py ./scripts/fetch-account-identity.py
COPY scripts/fetch-subnet-hyperparams.py ./scripts/fetch-subnet-hyperparams.py
COPY scripts/metagraph-fetch-entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh && chown -R fetcher:fetcher /app

USER fetcher
ENV PATH="/app/.venv/bin:$PATH"
# Provide at runtime: SCRIPT (one of fetch-metagraph-native.py /
# fetch-account-identity.py / fetch-subnet-hyperparams.py), SUBTENSOR_RPC_URL
# (non-secret -- our own fullnode's tailnet address), and whichever *_JSON
# output-path env var the target script reads (see each script's own
# OUT/module-level constant). Mount /out for the result.
ENTRYPOINT ["./entrypoint.sh"]
