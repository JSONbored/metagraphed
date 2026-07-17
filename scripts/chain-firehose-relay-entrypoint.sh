#!/usr/bin/env bash
# Runs the box-side realtime chain-event firehose relay (#4981, #5027, ADR
# 0015) -- see deploy/chain-firehose-relay.Dockerfile's header. Unlike the
# metagraph-fetch/data-refresh-node/economics-refresh entrypoints, this
# process is a single always-on daemon, not a periodically re-invoked job,
# so there's no persistent /repo volume or incremental-refresh branch here:
# every container start (rare -- a crash-restart, or a deliberate `docker
# compose up` after the Ansible role rebuilds the image) does one fresh,
# shallow clone, then execs the relay to run forever. This also means
# restarting the container (not just rebuilding the image) is enough to pick
# up whatever is newest on main.
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
# be a fixed, known path. Safe to hardcode here specifically because this
# entrypoint never reuses an existing checkout across container restarts
# (no persistent volume, see above) -- there is no "was this the leftover of
# an interrupted clone" ambiguity the other entrypoints' mktemp-then-copy
# pattern guards against, since the container filesystem itself is fresh
# every single time this path is written to.
REPO_DIR=/tmp/repo
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
