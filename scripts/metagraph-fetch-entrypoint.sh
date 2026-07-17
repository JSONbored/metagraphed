#!/usr/bin/env bash
# Runs one of the four box-side chain-direct fetch scripts, matching each
# script's own original GitHub-Actions invocation behavior -- see
# deploy/metagraph-fetch.Dockerfile's header for why this container holds no
# secrets.
#
# Clones this repo at CONTAINER RUNTIME rather than baking the scripts into
# the image at build time. A prior copy-based deployment (metagraphed-infra
# tracking its own local copy of these exact files, rebuilt on its own
# schedule) let real fixes silently go stale between the two repos: a
# fail-loud correctness fix and Sentry instrumentation both landed only in
# that copy and never made it back to this canonical source, until that
# drift was found and fixed directly. Matching
# scripts/data-refresh-node-entrypoint.sh's own established pattern instead
# closes that gap architecturally -- there is only ever one copy of these
# scripts anywhere, so there is nothing left to go stale.
set -euo pipefail

: "${SCRIPT:?SCRIPT env var required (fetch-metagraph-native.py / fetch-account-identity.py / fetch-subnet-hyperparams.py / fetch-validator-nominator-counts.py)}"

REPO_DIR=/repo
GIT_REPO_URL="https://github.com/JSONbored/metagraphed.git"
# Floating branch, not a pinned commit SHA -- same rationale as
# economics-refresh-entrypoint.sh/data-refresh-node-entrypoint.sh: this job
# needs to stay current with code fixes, and main already requires review +
# CI before anything lands.
GIT_REF="main"

if [ ! -d "$REPO_DIR/.git" ]; then
  # Clone into a temp dir, THEN copy its contents into $REPO_DIR -- an
  # interrupted clone straight into $REPO_DIR would leave a partial .git
  # directory that this same "already cloned?" check would treat as success
  # on the NEXT run, silently proceeding against a broken checkout (the same
  # fix economics-refresh-entrypoint.sh's own header documents finding via a
  # security review). Copy, not `mv`, for the same reason: $REPO_DIR is the
  # volume's own mount point, not a plain directory that can be
  # removed/replaced wholesale.
  CLONE_TMP="$(mktemp -d /tmp/metagraphed-clone.XXXXXX)"
  echo "entrypoint: cloning ${GIT_REPO_URL}@${GIT_REF} (first run on this volume)"
  git clone --depth 1 --branch "$GIT_REF" "$GIT_REPO_URL" "$CLONE_TMP"
  find "$REPO_DIR" -mindepth 1 -delete
  cp -a "$CLONE_TMP"/. "$REPO_DIR"/
  rm -rf "$CLONE_TMP"
else
  echo "entrypoint: refreshing existing checkout"
  git -C "$REPO_DIR" fetch --depth 1 origin "$GIT_REF"
  git -C "$REPO_DIR" reset --hard "origin/${GIT_REF}"
  # Deliberately NO `git clean -fdx` here, unlike the sibling JS entrypoints
  # -- scripts/.venv (uv's own dependency cache, persisted across runs on
  # this same volume so a daily/weekly cron tick doesn't pay a full
  # bittensor + sentry-sdk install every single time) is untracked and would
  # otherwise be wiped on every refresh, defeating the point of the
  # persistent volume. Nothing else in this checkout is ever written to
  # locally (these scripts write their OUTPUT to the separately-mounted
  # /out, never anywhere inside $REPO_DIR), so there's no equivalent risk of
  # stale local state the other entrypoints' git clean actually guards
  # against.
fi

cd "$REPO_DIR/scripts"
echo "entrypoint: uv sync --locked"
uv sync --locked

# Reports the ACTUAL commit this run's code came from -- computed here, not
# injected by metagraphed-infra's Ansible, since that repo no longer holds
# any copy of this code to derive a meaningful SHA from at all. An explicit
# override still wins if one is somehow already set.
: "${SENTRY_RELEASE:=$(git -C "$REPO_DIR" rev-parse HEAD)}"
export SENTRY_RELEASE

echo "entrypoint: uv run python ${SCRIPT} (release=${SENTRY_RELEASE})"
exec uv run python "${SCRIPT}"
