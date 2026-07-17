#!/usr/bin/env bash
# Builds/publishes one of the 3 core Cloudflare Workers and uploads its
# source maps to the consolidated `metagraphed` Sentry project, so a captured
# error's minified stack trace (workers/*.sentry.mjs bundle, e.g.
# "api.sentry.js:18:8835") resolves to real source. wrangler.*.jsonc's own
# upload_source_maps only makes wrangler PRODUCE source maps as build
# output -- it does not push them into Sentry; that needs this explicit
# sentry-cli step reading the same output directory.
#
# The release value is generated once here (sentry-cli releases propose-
# version, git-derived) and passed to the build itself via --var, so the
# Worker's OWN release tag at runtime (env.SENTRY_RELEASE, read by workers/
# *.sentry.mjs's withSentry() options callback -- see that file's own header)
# is the exact same value the source maps get uploaded under. Previously the
# runtime release fell back to CF_VERSION_METADATA's UUID, which has no
# relationship to a git commit -- this also makes Sentry's suspect-commit
# detection actually work against the linked JSONbored/metagraphed repo.
#
# Two modes, matching the two Cloudflare Workers Builds command slots each of
# the 3 Worker projects has (Settings -> Build):
#   Deploy command:                      scripts/deploy-worker-with-sourcemaps.sh <config.jsonc>
#   Non-production branch deploy command: scripts/deploy-worker-with-sourcemaps.sh <config.jsonc> --preview
# --preview uses `wrangler versions upload` (a non-promoting version, not
# live traffic -- confirmed supported: --outdir/--upload-source-maps/--var
# all work identically on this subcommand, `wrangler versions upload --help`)
# instead of `wrangler deploy`, and tags the release/environment as preview
# so these don't get filed as production events or dilute suspect-commit
# data for a real release -- none of the 3 wrangler configs define a
# separate non-prod environment (wrangler.data.jsonc/wrangler.registry.jsonc
# even say so explicitly, "preview_urls: false"), so this is the one thing
# that keeps a branch build's errors distinguishable from production's
# despite sharing the exact same bindings/database.
#
# Needs SENTRY_AUTH_TOKEN set as a Workers BUILD secret (not a runtime
# Variable/Secret -- sentry-cli only runs during the build, never reaches the
# deployed Worker) on each of the 3 Worker projects.
#
# Usage: scripts/deploy-worker-with-sourcemaps.sh <wrangler-config.jsonc> [--preview]
set -euo pipefail

CONFIG="$1"
PREVIEW="${2:-}"

BASENAME="$(basename "$CONFIG" .jsonc)"
ENVIRONMENT="production"
WRANGLER_SUBCOMMAND=(deploy)
OUTDIR="dist/worker-$BASENAME"

if [[ "$PREVIEW" == "--preview" ]]; then
  ENVIRONMENT="preview"
  WRANGLER_SUBCOMMAND=(versions upload)
  OUTDIR="dist/worker-$BASENAME-preview"
fi

export SENTRY_ORG="jsonbored"
export SENTRY_PROJECT="metagraphed"

RELEASE=$(npx sentry-cli releases propose-version)
if [[ "$ENVIRONMENT" == "preview" ]]; then
  RELEASE="$RELEASE-preview"
fi

npx wrangler "${WRANGLER_SUBCOMMAND[@]}" \
  --config "$CONFIG" \
  --outdir "$OUTDIR" \
  --upload-source-maps \
  --var "SENTRY_RELEASE:$RELEASE" \
  --var "SENTRY_ENVIRONMENT:$ENVIRONMENT"

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
