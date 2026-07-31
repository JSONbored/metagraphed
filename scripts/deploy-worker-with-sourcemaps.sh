#!/usr/bin/env bash
# Builds/publishes one of the 3 core Cloudflare Workers and uploads its
# source maps to PostHog Error Tracking, so a captured error's minified
# stack trace resolves to real source. wrangler.*.jsonc's own
# upload_source_maps is Cloudflare's own separate Sourcemap Uploads
# product (its own dashboard/logs symbolication) -- it does not push
# anything to PostHog; that needs the posthog-cli steps below.
#
# Two modes, matching the two Cloudflare Workers Builds command slots each of
# the 3 Worker projects has (Settings -> Build):
#   Deploy command:                      scripts/deploy-worker-with-sourcemaps.sh <config.jsonc>
#   Non-production branch deploy command: scripts/deploy-worker-with-sourcemaps.sh <config.jsonc> --preview
# --preview uses `wrangler versions upload` (a non-promoting version, not
# live traffic) instead of `wrangler deploy`, and tags the release as
# preview so these don't dilute production release data -- none of the 3
# wrangler configs define a separate non-prod environment
# (wrangler.data.jsonc/wrangler.registry.jsonc even say so explicitly,
# "preview_urls: false"), so this is the one thing that keeps a branch
# build's errors distinguishable from production's despite sharing the
# exact same bindings/database.
#
# Needs POSTHOG_CLI_API_KEY/POSTHOG_CLI_PROJECT_ID set as Workers BUILD
# secrets/vars (not a runtime Variable/Secret -- posthog-cli only runs
# during the build, never reaches the deployed Worker) on each of the 3
# Worker projects. Fully inert -- a plain build+deploy, no sourcemap
# upload attempted -- when either is unset.
#
# `posthog-cli` embeds a `//# chunkId=...` marker directly into the shipped
# JS: that marker MUST be present in the EXACT bytes Cloudflare actually
# serves, or PostHog can never match a captured stack trace back to the
# uploaded map (confirmed against PostHog's own docs -- "If you serve a
# copy of the bundled assets as they were prior to running posthog-cli
# sourcemap inject, we won't be able to use the uploaded sourcemap"). A
# single `wrangler deploy --outdir` builds AND ships atomically, so
# injecting into $OUTDIR afterward would modify a local copy that was
# never actually deployed. Instead: (1) `wrangler deploy --dry-run` builds
# WITHOUT deploying (Cloudflare's own documented use for exactly this
# purpose -- "gives developers a chance to upload our generated
# sourcemap to a service... before the service goes live"), (2)
# `posthog-cli sourcemap inject` embeds the marker into that build output,
# (3) `wrangler deploy --no-bundle` ships THAT EXACT injected file,
# skipping wrangler's own esbuild step (which would otherwise silently
# rebuild from source and discard the marker just injected). Verified
# locally: the dry-run build + inject steps (single flat `<entry>.js`/
# `.js.map` per Worker, no code-splitting -- confirmed via `wrangler
# deploy --dry-run --outdir` against wrangler.jsonc). The `--no-bundle`
# deploy step (3) could not be safely tested against a live Worker from a
# dev sandbox -- watch the first real deploy after this lands closely.
#
# --message passed on the wrangler call itself (metagraphed#7224): the
# deployed commit SHA needs to land in the deployment's own real
# `workers/message` annotation (confirmed against Cloudflare's List
# Deployments API reference + wrangler's own CLI source -- `workers/message`/
# `workers/tag`/`workers/triggered_by` are the only Workers deployment
# annotations that actually exist; `workers/commit_hash`
# scripts/check-worker-deploy-drift.ts previously checked was never a real
# one, that key only exists on Cloudflare Pages' unrelated deploy command)
# so that scheduled drift check can read the live commit directly.
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

COMMIT_SHA=$(git rev-parse HEAD)
RELEASE_NAME="metagraphed-$BASENAME"
RELEASE_VERSION="$COMMIT_SHA"
if [[ "$ENVIRONMENT" == "preview" ]]; then
  RELEASE_VERSION="$COMMIT_SHA-preview"
fi

POSTHOG_ENABLED=false
if [[ -n "${POSTHOG_CLI_API_KEY:-}" && -n "${POSTHOG_CLI_PROJECT_ID:-}" ]]; then
  POSTHOG_ENABLED=true
fi

if [[ "$POSTHOG_ENABLED" == "true" ]]; then
  # Phase 1: build only -- writes $OUTDIR/<entry>.js(.map) without deploying
  # (see this file's own header comment for why a single combined build+
  # deploy command can't be injected into afterward).
  npx wrangler "${WRANGLER_SUBCOMMAND[@]}" \
    --config "$CONFIG" \
    --outdir "$OUTDIR" \
    --upload-source-maps \
    --message "$COMMIT_SHA" \
    --dry-run

  # Phase 2: inject PostHog's chunk-ID marker into the just-built bundle,
  # BEFORE it ever ships.
  # --release-name/--release-version passed HERE as well as on the upload in
  # phase 4, not just there. `inject` creates a release too, and without these
  # it auto-derives one from git -- which is `metagraphed@<commit>` for EVERY
  # Worker and BOTH modes of a given commit. The bundle bytes for one Worker
  # are identical in production and preview, so the second of the two deploys
  # hit `release_hash_in_use` and the whole deploy command failed
  # (metagraphed-data-api, 2026-07-31). posthog-cli's own help says these are
  # "strongly recommended to be set explicitly during release CD workflows",
  # and this is why: they are what makes the 3 Workers x 2 modes distinct.
  npx @posthog/cli sourcemap inject \
    --directory "$OUTDIR" \
    --release-name "$RELEASE_NAME" \
    --release-version "$RELEASE_VERSION"

  # Phase 3: ship the EXACT injected file -- --no-bundle skips wrangler's
  # own esbuild step (which would otherwise rebuild from source and discard
  # the marker just injected above). ENTRY_JS is the single flat bundle
  # wrangler's own build produces for these Workers (no code-splitting for
  # a single-entry Worker, confirmed locally) -- resolved by globbing
  # rather than hardcoded per-Worker, since each of the 3 configs' `main`
  # basename differs.
  ENTRY_JS=$(find "$OUTDIR" -maxdepth 1 -name '*.js')
  npx wrangler "${WRANGLER_SUBCOMMAND[@]}" \
    "$ENTRY_JS" \
    --config "$CONFIG" \
    --no-bundle \
    --message "$COMMIT_SHA"

  # Phase 4: upload, now safe -- $OUTDIR's injected bundle IS what phase 3
  # actually deployed, so this correctly resolves real production traces.
  npx @posthog/cli sourcemap upload \
    --directory "$OUTDIR" \
    --release-name "$RELEASE_NAME" \
    --release-version "$RELEASE_VERSION"
else
  npx wrangler "${WRANGLER_SUBCOMMAND[@]}" \
    --config "$CONFIG" \
    --outdir "$OUTDIR" \
    --upload-source-maps \
    --message "$COMMIT_SHA"
fi
