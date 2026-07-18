#!/usr/bin/env bash
# Runs the box-side realtime chain-event firehose relay (#4981, #5027, ADR
# 0015) -- see deploy/chain-firehose-relay.Dockerfile's header. Unlike the
# metagraph-fetch/data-refresh-node/economics-refresh entrypoints, this
# process is a single always-on daemon, not a periodically re-invoked job,
# so there's no persistent /repo volume or incremental-refresh branch here:
# every container start does one fresh, shallow clone, then execs the relay
# to run forever.
#
# A `docker run` (a genuinely new container + fresh writable layer) always
# picks up whatever is newest on main this way. `docker restart` does NOT --
# it reuses the SAME container and its writable layer, so $REPO_DIR from the
# PRIOR run is still there; confirmed live (2026-07-17, 2026-07-18) that an
# earlier version of this script, which cloned straight into $REPO_DIR with
# no cleanup, hit `fatal: destination path '/tmp/repo' already exists and is
# not an empty directory` on every restart and crash-looped forever instead
# of ever reaching the relay process. The `rm -rf "$REPO_DIR"` below exists
# specifically so a plain `docker restart` is safe too, not just `docker run`
# -- deploying a merged fix should still prefer `docker stop && docker rm &&
# docker run` (a cleaner, fully-fresh container), but a restart no longer
# crash-loops if that's what actually gets reached for.
set -euo pipefail

GIT_REPO_URL="https://github.com/JSONbored/metagraphed.git"
# Floating branch, not a pinned commit SHA -- same rationale as the other
# clone-at-runtime entrypoints (data-refresh-node-entrypoint.sh,
# economics-refresh-entrypoint.sh): main already requires review + CI +
# Loopover ORB before anything lands.
GIT_REF="main"

# A FIXED path, not mktemp's random suffix -- unlike the other clone-at-
# runtime entrypoints, the Docker HEALTHCHECK directive (see the Dockerfile)
# execs `node <path>/scripts/chain-firehose-relay.mjs --healthcheck`
# directly, baked into the image at build time, so the clone location must
# be a fixed, known path. The `rm -rf` immediately below (not the other
# entrypoints' mktemp-then-copy pattern) is what keeps this safe to
# hardcode: `git clone` itself refuses to write into a non-empty directory,
# so the wipe has to happen before every clone, not just the first one on a
# given container.
REPO_DIR=/tmp/repo
rm -rf "$REPO_DIR"
echo "entrypoint: cloning ${GIT_REPO_URL}@${GIT_REF} into ${REPO_DIR}"
git clone --depth 1 --branch "$GIT_REF" "$GIT_REPO_URL" "$REPO_DIR"
cd "$REPO_DIR"

echo "entrypoint: npm ci --ignore-scripts"
npm ci --ignore-scripts --no-audit --no-fund
# --ignore-scripts closes the install-time-arbitrary-code vector (lifecycle
# scripts from any of this repo's npm dependencies); this check catches
# anything that still wrote to the tracked source tree some other way. Same
# defense as economics-refresh-entrypoint.sh / data-refresh-node-entrypoint.sh.
if ! git diff --quiet -- . ':(exclude)node_modules'; then
  echo "entrypoint: npm ci modified tracked source files -- aborting" >&2
  git diff --stat -- . ':(exclude)node_modules' >&2
  exit 1
fi

# Sentry release -- the freshly-cloned HEAD, since this script now lives
# only in metagraphed (metagraphed#6451): metagraphed-infra's own commit SHA
# would no longer identify what code is actually running here.
: "${SENTRY_RELEASE:=$(git rev-parse HEAD)}"
export SENTRY_RELEASE

echo "entrypoint: node scripts/chain-firehose-relay.mjs (release ${SENTRY_RELEASE})"
exec node scripts/chain-firehose-relay.mjs
