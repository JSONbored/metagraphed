#!/usr/bin/env bash
# Runs one step of the box-side Node-only data-refresh jobs (registry-sync,
# testnet-discovery) -- see deploy/data-refresh-node.Dockerfile's header.
# Unlike deploy/economics-refresh.Dockerfile's two-container split, neither
# job here needs a separate untrusted-fetch step: both are pure JS with no
# PyPI/uvx involved, so npm ci's own --ignore-scripts + integrity check
# (below) is the only supply-chain guard needed, in ONE container.
set -euo pipefail

: "${STEP:?STEP env var required (registry-sync|testnet-discovery)}"

REPO_DIR=/repo
GIT_REPO_URL="https://github.com/JSONbored/metagraphed.git"
# Floating branch, not a pinned commit SHA -- same rationale as
# economics-refresh-entrypoint.sh: both jobs need to stay current with
# registry data and code fixes, and main already requires review + CI +
# the Gittensory Gate before anything lands.
GIT_REF="main"

if [ ! -d "$REPO_DIR/.git" ]; then
  # Clone into a temp dir, THEN copy its contents into $REPO_DIR -- see
  # economics-refresh-entrypoint.sh's identical comment for why (an
  # interrupted clone straight into $REPO_DIR would leave a partial .git
  # that the next run's "already cloned?" check would treat as success;
  # $REPO_DIR is the volume's own mount point, not a plain directory, so
  # it can't be removed/replaced wholesale).
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
  git -C "$REPO_DIR" clean -fdx
fi

cd "$REPO_DIR"
echo "entrypoint: npm ci --ignore-scripts"
npm ci --ignore-scripts --no-audit --no-fund
# --ignore-scripts closes the install-time-arbitrary-code vector (lifecycle
# scripts from any of ~600 npm packages); this check catches anything that
# still wrote to the tracked source tree some other way. Same defense as
# economics-refresh-entrypoint.sh's install_deps -- found necessary there via
# a security review, applied here from the start.
if ! git diff --quiet -- . ':(exclude)node_modules'; then
  echo "entrypoint: npm ci modified tracked source files -- aborting" >&2
  git diff --stat -- . ':(exclude)node_modules' >&2
  exit 1
fi

case "$STEP" in
  registry-sync)
    : "${REGISTRY_SYNC_SECRET:?REGISTRY_SYNC_SECRET env var required for the registry-sync step}"
    echo "entrypoint: full registry resync to Postgres"
    exec node scripts/backfill-registry-postgres.mjs
    ;;
  testnet-discovery)
    echo "entrypoint: probing testnet subnet surfaces"
    node scripts/discover-testnet-surfaces.mjs --out /tmp/testnet-discovery.json
    callable_count="$(node -e "process.stdout.write(String(require('/tmp/testnet-discovery.json').summary.callable_count))")"
    if [ "$callable_count" != "0" ]; then
      echo "entrypoint: $callable_count testnet subnet(s) now expose a callable API -- promote them to curated testnet surfaces"
      if [ -n "${LIVE_ALERT_WEBHOOK_URL:-}" ]; then
        payload="$(node -e "process.stdout.write(JSON.stringify({content:\`ℹ️ metagraphed testnet-discovery: \${process.argv[1]} subnet(s) now expose a callable API — promote to curated testnet surfaces.\`}))" "$callable_count")"
        curl -fsS -m 15 -X POST "$LIVE_ALERT_WEBHOOK_URL" -H "content-type: application/json" -d "$payload" || echo "entrypoint: testnet-discovery alert webhook failed" >&2
      fi
    fi
    ;;
  *)
    echo "entrypoint: unknown STEP '$STEP' (want registry-sync|testnet-discovery)" >&2
    exit 1
    ;;
esac
