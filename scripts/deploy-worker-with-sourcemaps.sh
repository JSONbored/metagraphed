#!/usr/bin/env bash
# Deploys one of the 3 core Cloudflare Workers and uploads its source maps to
# the consolidated `metagraphed` Sentry project, so a captured error's
# minified stack trace (workers/*.sentry.mjs bundle, e.g. "api.sentry.js:
# 18:8835") resolves to real source. wrangler.*.jsonc's own upload_source_maps
# only makes wrangler PRODUCE source maps as build output -- it does not push
# them into Sentry; that needs this explicit sentry-cli step reading the same
# output directory.
#
# The release value is generated once here (sentry-cli releases propose-
# version, git-derived) and passed to the deploy itself via --var, so the
# Worker's OWN release tag at runtime (env.SENTRY_RELEASE, read by workers/
# *.sentry.mjs's withSentry() options callback -- see that file's own header)
# is the exact same value the source maps get uploaded under. Previously the
# runtime release fell back to CF_VERSION_METADATA's UUID, which has no
# relationship to a git commit -- this also makes Sentry's suspect-commit
# detection actually work against the linked JSONbored/metagraphed repo.
#
# Run via Cloudflare Workers Builds' own "Deploy command" setting (Settings ->
# Build) for each Worker project -- not invoked by any GitHub Actions
# workflow, these 3 Workers deploy through Cloudflare's own git-triggered
# build system. Needs SENTRY_AUTH_TOKEN set as a Workers BUILD secret (not a
# runtime Variable/Secret -- sentry-cli only runs during the build, never
# reaches the deployed Worker) on each of the 3 Worker projects.
#
# Usage: scripts/deploy-worker-with-sourcemaps.sh <wrangler-config.jsonc>
set -euo pipefail

CONFIG="$1"
OUTDIR="dist/worker-$(basename "$CONFIG" .jsonc)"

export SENTRY_ORG="jsonbored"
export SENTRY_PROJECT="metagraphed"

RELEASE=$(npx sentry-cli releases propose-version)

npx wrangler deploy \
  --config "$CONFIG" \
  --outdir "$OUTDIR" \
  --upload-source-maps \
  --var "SENTRY_RELEASE:$RELEASE"

npx sentry-cli releases new "$RELEASE"
# --auto reads the linked GitHub repo's commit range since the last release
# (Sentry's GitHub integration, connected separately in the dashboard) --
# powers suspect-commit detection on issues from this release.
npx sentry-cli releases set-commits "$RELEASE" --auto
npx sentry-cli sourcemaps upload \
  --release="$RELEASE" \
  --strip-prefix "$OUTDIR/.." \
  "$OUTDIR"
npx sentry-cli releases finalize "$RELEASE"
