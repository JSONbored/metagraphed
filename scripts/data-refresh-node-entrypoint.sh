#!/usr/bin/env bash
# Runs one step of the box-side Node-only data-refresh jobs (registry-sync,
# registry-sync-fast, testnet-discovery) -- see
# deploy/data-refresh-node.Dockerfile's header. Unlike deploy/economics-
# refresh.Dockerfile's two-container split, none of these need a separate
# untrusted-fetch step: all are pure JS with no PyPI/uvx involved, so npm
# ci's own --ignore-scripts + integrity check (below) is the only
# supply-chain guard needed, in ONE container.
set -euo pipefail

: "${STEP:?STEP env var required (registry-sync|registry-sync-fast|testnet-discovery)}"

REPO_DIR=/repo
GIT_REPO_URL="https://github.com/JSONbored/metagraphed.git"
# Floating branch, not a pinned commit SHA -- same rationale as
# economics-refresh-entrypoint.sh: all three jobs need to stay current with
# registry data and code fixes, and main already requires review + CI +
# the Gittensory Gate before anything lands.
GIT_REF="main"
# registry-sync-fast's own state: the last commit it successfully synced.
# Lives inside .git/ specifically -- git clean -fdx (used by the other two
# jobs' full refresh) never touches .git/'s own contents, so this file
# survives even if this same volume were ever reused by a different STEP.
STATE_FILE="$REPO_DIR/.git/last-registry-sync-sha"

install_deps() {
  cd "$REPO_DIR"
  echo "entrypoint: npm ci --ignore-scripts"
  npm ci --ignore-scripts --no-audit --no-fund
  # --ignore-scripts closes the install-time-arbitrary-code vector (lifecycle
  # scripts from any of ~600 npm packages); this check catches anything that
  # still wrote to the tracked source tree some other way. Same defense as
  # economics-refresh-entrypoint.sh's install_deps -- found necessary there
  # via a security review, applied here from the start.
  if ! git diff --quiet -- . ':(exclude)node_modules'; then
    echo "entrypoint: npm ci modified tracked source files -- aborting" >&2
    git diff --stat -- . ':(exclude)node_modules' >&2
    exit 1
  fi
}

if [ "$STEP" = "registry-sync-fast" ]; then
  # Tight-cadence poll (every few minutes) standing in for the retired
  # push-triggered sync-registry-to-postgres.yml, WITHOUT needing GitHub
  # webhook/PAT infrastructure on the box: cheap-check first (a fetch + SHA
  # compare), only pay for a full checkout refresh + npm ci when something
  # actually changed since the last run. The box's registry-sync job (full
  # resync every 6h) is the safety net if this ever misses a tick, so a
  # transient miss here is never a real data-loss risk, only a latency one.
  #
  # FULL clone/fetch, not --depth 1 like the other two jobs: sync-registry-
  # to-postgres.mjs diffs `git diff base..head` between the last-synced SHA
  # and the current one, which can be several commits back by the time this
  # runs -- a shallow clone wouldn't have that history locally and the diff
  # would fail with an unknown-revision error. ~58MB packed for this repo,
  # trivial to keep full.
  if [ ! -d "$REPO_DIR/.git" ]; then
    echo "entrypoint: cloning ${GIT_REPO_URL}@${GIT_REF} (full history, first run on this volume)"
    CLONE_TMP="$(mktemp -d /tmp/metagraphed-clone.XXXXXX)"
    git clone --branch "$GIT_REF" "$GIT_REPO_URL" "$CLONE_TMP"
    find "$REPO_DIR" -mindepth 1 -delete
    cp -a "$CLONE_TMP"/. "$REPO_DIR"/
    rm -rf "$CLONE_TMP"
    install_deps
    # First-ever run: nothing to diff against yet. Bootstrap to HEAD rather
    # than back-syncing all history -- the 6h full resync already covers
    # the complete current state, this job only needs to catch changes
    # FROM HERE FORWARD.
    git -C "$REPO_DIR" rev-parse HEAD > "$STATE_FILE"
    echo "entrypoint: registry-sync-fast bootstrapped, nothing to sync yet"
    exit 0
  fi

  git -C "$REPO_DIR" fetch origin "$GIT_REF"
  NEW_HEAD="$(git -C "$REPO_DIR" rev-parse "origin/${GIT_REF}")"
  LAST_SYNCED="$(cat "$STATE_FILE" 2>/dev/null || true)"

  if [ -z "$LAST_SYNCED" ]; then
    # Defensive: state file missing despite an existing checkout (shouldn't
    # happen given the bootstrap above, but never invent a --base to diff
    # from) -- re-bootstrap to current HEAD instead of guessing.
    echo "entrypoint: registry-sync-fast: no prior sync state, re-bootstrapping to HEAD"
    git -C "$REPO_DIR" reset --hard "origin/${GIT_REF}"
    echo "$NEW_HEAD" > "$STATE_FILE"
    exit 0
  fi

  if [ "$NEW_HEAD" = "$LAST_SYNCED" ]; then
    echo "entrypoint: registry-sync-fast: no change since last sync ($LAST_SYNCED)"
    exit 0
  fi

  echo "entrypoint: registry-sync-fast: $LAST_SYNCED -> $NEW_HEAD"
  git -C "$REPO_DIR" reset --hard "origin/${GIT_REF}"
  git -C "$REPO_DIR" clean -fdx
  install_deps

  : "${REGISTRY_SYNC_SECRET:?REGISTRY_SYNC_SECRET env var required for the registry-sync-fast step}"
  node scripts/sync-registry-to-postgres.mjs --base "$LAST_SYNCED" --head "$NEW_HEAD"
  echo "$NEW_HEAD" > "$STATE_FILE"
  exit 0
fi

# registry-sync / testnet-discovery: always do a full refresh + npm ci --
# low enough cadence (6h / weekly) that this cost doesn't matter, and
# neither needs cross-commit history (registry-sync does a full resync of
# current state regardless of what changed; testnet-discovery doesn't touch
# git history at all), so --depth 1 is fine for both.
if [ ! -d "$REPO_DIR/.git" ]; then
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
install_deps

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
    echo "entrypoint: unknown STEP '$STEP' (want registry-sync|registry-sync-fast|testnet-discovery)" >&2
    exit 1
    ;;
esac
