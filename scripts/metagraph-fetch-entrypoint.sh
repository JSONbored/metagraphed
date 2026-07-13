#!/usr/bin/env bash
# Runs exactly one of the three fetch scripts via uv, matching each script's
# own GitHub-Actions invocation (`uvx --from bittensor==X.Y python <script>`)
# so behavior stays identical to what refresh-*.yml's `fetch` job already
# proved out -- see deploy/metagraph-fetch.Dockerfile's header for why this
# container holds no secrets.
#
# A security scan (2026-07-13) correctly flagged that this resolves bittensor
# from PyPI at runtime with a pinned SEMVER but no hash/checksum pin, so a
# compromised release at that exact version (or one of its transitive deps)
# could execute inside this container. Accepted as-is rather than switching
# to a hash-locked requirements file: (1) this is the SAME resolution
# GitHub Actions already ran in production for months before this migration
# -- not a new or wider exposure, just relocated; (2) the container that runs
# it holds zero secrets and no path to anything sensitive (see the Dockerfile
# header) -- worst case is a bad JSON payload, which the separate,
# secret-holding sync step in refresh-job.sh.j2 would still only ever POST
# through the destination Worker's own row-shape/bounds validation, never
# execute. Revisit if these scripts ever gain a real dependency lockfile.
set -euo pipefail

: "${SCRIPT:?SCRIPT env var required (fetch-metagraph-native.py / fetch-account-identity.py / fetch-subnet-hyperparams.py)}"
: "${BITTENSOR_VERSION:?BITTENSOR_VERSION env var required, e.g. 10.4.0}"

echo "entrypoint: uvx --from bittensor==${BITTENSOR_VERSION} python scripts/${SCRIPT}"
exec uvx --from "bittensor==${BITTENSOR_VERSION}" python "scripts/${SCRIPT}"
