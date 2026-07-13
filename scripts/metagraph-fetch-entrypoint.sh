#!/usr/bin/env bash
# Runs exactly one of the three fetch scripts, matching each script's own
# original GitHub-Actions invocation behavior -- see
# deploy/metagraph-fetch.Dockerfile's header for why this container holds no
# secrets, and for why bittensor is now baked into the image at build time
# (hash-locked via scripts/uv.lock) rather than resolved fresh from PyPI on
# every run (fixed 2026-07-14 in response to a security scan finding, P2).
set -euo pipefail

: "${SCRIPT:?SCRIPT env var required (fetch-metagraph-native.py / fetch-account-identity.py / fetch-subnet-hyperparams.py)}"

echo "entrypoint: python scripts/${SCRIPT} (bittensor pinned + hash-locked at image build time, see scripts/uv.lock)"
exec python "scripts/${SCRIPT}"
