#!/usr/bin/env bash
# Runs one step of the box-side live-economics refresh (replaces
# .github/workflows/refresh-economics.yml) -- see
# deploy/economics-refresh.Dockerfile's header for the two-container trust
# boundary this preserves (this same entrypoint drives both containers, the
# STEP env var picks which).
set -euo pipefail

: "${STEP:?STEP env var required (snapshot|economics)}"

REPO_DIR=/repo
GIT_REPO_URL="https://github.com/JSONbored/metagraphed.git"
# Floating branch, not a pinned commit SHA -- deliberate: this job's whole
# purpose is staying current with registry/subnets/*.json (contributor PRs
# land on main continuously) as well as any code fixes, so pinning would
# defeat that and require manual re-pinning on every deploy. main already
# requires review + CI + the Gittensory Gate before anything lands, the
# same trust level every other box job implicitly extends to this repo.
# (A security review flagged the unpinned clone given this same container
# later holds CLOUDFLARE_API_TOKEN in the economics step -- considered, not
# overlooked; see the atomic-clone fix just below for the finding that WAS
# worth fixing from that same review.)
GIT_REF="main"

# npm ci runs in the SAME shared /repo volume the economics step later reads
# scripts/refresh-economics.ts (and node_modules/.bin/wrangler, the exact
# binary that makes the authenticated Cloudflare API call) from -- a
# security review correctly pointed out that this breaks the stated trust
# boundary between the snapshot step (untrusted, no secrets) and the
# economics step (holds CLOUDFLARE_API_TOKEN): a malicious postinstall/
# preinstall/prepare script from any of ~600 npm packages, running during
# the SNAPSHOT step's npm ci, could plant or modify a file the ECONOMICS
# step later executes with the real token in scope. --ignore-scripts closes
# the install-time-arbitrary-code vector (this repo's own package.json has
# no lifecycle scripts of its own, confirmed); the git diff check below is
# defense in depth against anything that still wrote to the tracked source
# tree some other way.
install_deps() {
  echo "entrypoint: npm ci --ignore-scripts"
  npm ci --ignore-scripts --no-audit --no-fund
  if ! git diff --quiet -- . ':(exclude)node_modules'; then
    echo "entrypoint: npm ci modified tracked source files -- aborting" >&2
    git diff --stat -- . ':(exclude)node_modules' >&2
    exit 1
  fi
}

if [ ! -d "$REPO_DIR/.git" ]; then
  # Clone into a temp dir, THEN copy its contents into $REPO_DIR -- an
  # interrupted clone straight into $REPO_DIR would leave a partial .git
  # directory that this same "already cloned?" check would treat as success
  # on the NEXT run, silently proceeding against a broken checkout (flagged
  # by a security review on the PR that added this script; real, cheap to
  # fix). Copy, not `mv $CLONE_TMP $REPO_DIR` -- $REPO_DIR is the volume's
  # own mount point, not a plain directory, so it can't be removed/replaced
  # wholesale (`rm -rf $REPO_DIR` fails with "Device or resource busy",
  # hit this for real testing the first version of this fix).
  CLONE_TMP="$(mktemp -d /tmp/metagraphed-clone.XXXXXX)"
  echo "entrypoint: cloning ${GIT_REPO_URL}@${GIT_REF} (first run on this volume)"
  git clone --depth 1 --branch "$GIT_REF" "$GIT_REPO_URL" "$CLONE_TMP"
  find "$REPO_DIR" -mindepth 1 -delete
  cp -a "$CLONE_TMP"/. "$REPO_DIR"/
  rm -rf "$CLONE_TMP"
  cd "$REPO_DIR"
  install_deps
elif [ "$STEP" = "snapshot" ]; then
  # Only the snapshot step re-syncs the checkout -- it always runs FIRST (see
  # roles/data-refresh-economics/files/refresh-economics.sh in
  # metagraphed-infra) and writes registry/native/finney-subnets.json as a
  # local, UNCOMMITTED change for the economics step to read right after.
  # The economics step must NOT also reset/clean here, or it would wipe that
  # freshly-written file back to whatever's committed on origin/main before
  # ever reading it (hit this for real in local testing: the economics
  # artifact came back with a month-stale captured_at because git clean -fdx
  # deleted the snapshot the prior container had just written).
  echo "entrypoint: refreshing existing checkout"
  git -C "$REPO_DIR" fetch --depth 1 origin "$GIT_REF"
  git -C "$REPO_DIR" reset --hard "origin/${GIT_REF}"
  git -C "$REPO_DIR" clean -fdx
  cd "$REPO_DIR"
  install_deps
else
  echo "entrypoint: reusing existing checkout as-is (economics step runs right after snapshot, same volume)"
  cd "$REPO_DIR"
fi

# Reports the ACTUAL commit whichever step runs next came from. Placed here
# (after all three branches above, not inside install_deps) because the
# economics step's own branch deliberately skips install_deps -- it reuses
# the SAME volume the snapshot container's install_deps just populated, a
# separate `docker run` invocation with its own fresh environment, so
# SENTRY_RELEASE would otherwise be unset for that step specifically. An
# explicit override still wins if one is somehow already set.
: "${SENTRY_RELEASE:=$(git -C "$REPO_DIR" rev-parse HEAD)}"
export SENTRY_RELEASE

case "$STEP" in
  snapshot)
    : "${SUBTENSOR_RPC_URL:?SUBTENSOR_RPC_URL env var required for the snapshot step}"
    echo "entrypoint: refreshing native chain snapshot"
    exec node scripts/refresh-native-snapshot.mjs
    ;;
  economics)
    echo "entrypoint: publishing live economics"
    exec node scripts/refresh-economics.ts --write
    ;;
  *)
    echo "entrypoint: unknown STEP '$STEP' (want snapshot|economics)" >&2
    exit 1
    ;;
esac
