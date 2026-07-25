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
# PostHog sourcemap upload (metagraphed#8128) is a SEPARATE, additive step,
# gated on POSTHOG_CLI_API_KEY/POSTHOG_CLI_PROJECT_ID being set the same way
# (Workers BUILD secrets/vars) -- completely inert, original single-command
# build+deploy flow unchanged, until both are configured. Unlike Sentry's
# release-based association, `posthog-cli` embeds a `//# chunkId=...` marker
# directly into the shipped JS: that marker MUST be present in the EXACT
# bytes Cloudflare actually serves, or PostHog can never match a captured
# stack trace back to the uploaded map (confirmed against PostHog's own
# docs -- "If you serve a copy of the bundled assets as they were prior to
# running posthog-cli sourcemap inject, we won't be able to use the
# uploaded sourcemap"). A single `wrangler deploy --outdir` builds AND ships
# atomically, so injecting into $OUTDIR afterward would modify a local copy
# that was never actually deployed. When PostHog is configured, this script
# instead: (1) `wrangler deploy --dry-run` builds WITHOUT deploying
# (Cloudflare's own documented use for exactly this purpose -- "gives
# developers a chance to upload our generated sourcemap to a service...
# before the service goes live"), (2) `posthog-cli sourcemap inject` embeds
# the marker into that build output, (3) `wrangler deploy --no-bundle` ships
# THAT EXACT injected file, skipping wrangler's own esbuild step (which
# would otherwise silently rebuild from source and discard the marker just
# injected). Verified locally: the dry-run build + inject steps (single
# flat `<entry>.js`/`.js.map` per Worker, no code-splitting -- confirmed via
# `wrangler deploy --dry-run --outdir` against wrangler.jsonc). The
# `--no-bundle` deploy step (3) could not be safely tested against a live
# Worker from a dev sandbox -- watch the first real deploy after this lands
# closely, and consider setting the two POSTHOG_CLI_* vars on a Worker
# project's non-production branch deploy command slot first (--preview mode
# below uses `wrangler versions upload`, which never serves live traffic).
#
# --message also passed on the wrangler call itself (metagraphed#7224): the
# deployed commit SHA needs to land in the deployment's own real
# `workers/message` annotation (confirmed against Cloudflare's List
# Deployments API reference + wrangler's own CLI source -- `workers/message`/
# `workers/tag`/`workers/triggered_by` are the only Workers deployment
# annotations that actually exist; `workers/commit_hash` scripts/check-worker-
# deploy-drift.mjs previously checked was never a real one, that key only
# exists on Cloudflare Pages' unrelated deploy command) so that scheduled
# drift check can read the live commit directly instead of relying solely on
# its Sentry-release fallback.
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
COMMIT_SHA=$(git rev-parse HEAD)

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
    --var "SENTRY_RELEASE:$RELEASE" \
    --var "SENTRY_ENVIRONMENT:$ENVIRONMENT" \
    --message "$COMMIT_SHA" \
    --dry-run

  # Phase 2: inject PostHog's chunk-ID marker into the just-built bundle,
  # BEFORE it ever ships.
  npx @posthog/cli sourcemap inject --directory "$OUTDIR"

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
    --var "SENTRY_RELEASE:$RELEASE" \
    --var "SENTRY_ENVIRONMENT:$ENVIRONMENT" \
    --message "$COMMIT_SHA"
else
  npx wrangler "${WRANGLER_SUBCOMMAND[@]}" \
    --config "$CONFIG" \
    --outdir "$OUTDIR" \
    --upload-source-maps \
    --var "SENTRY_RELEASE:$RELEASE" \
    --var "SENTRY_ENVIRONMENT:$ENVIRONMENT" \
    --message "$COMMIT_SHA"
fi

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

if [[ "$POSTHOG_ENABLED" == "true" ]]; then
  # Safe now: $OUTDIR's injected bundle IS what phase 3 above actually
  # deployed, so this upload correctly resolves real production traces.
  npx @posthog/cli sourcemap upload \
    --directory "$OUTDIR" \
    --release-name "metagraphed-$BASENAME" \
    --release-version "$RELEASE"
fi
