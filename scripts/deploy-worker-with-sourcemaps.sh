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
# rebuild from source and discard the marker just injected). The API Worker
# uses native ESM chunks below its entry; both PostHog phases traverse them,
# and Wrangler collects them unchanged through find_additional_modules.
#
# --message passed on the wrangler call itself (metagraphed#7224): the
# deployed commit SHA needs to land in the deployment's own real
# `workers/message` annotation (confirmed against Cloudflare's List
# Deployments API reference + wrangler's own CLI source -- `workers/message`/
# `workers/tag`/`workers/triggered_by` are the only Workers deployment
# annotations that actually exist; `workers/commit_hash`
# scripts/check-worker-deploys.ts reads was never a real
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

# ...AND THE CLI HAS TO BE INSTALLED (#10916). `@posthog/cli` is an optional
# dependency now, reached through apps/ui's optional `@posthog/rollup-plugin`:
# its postinstall downloads a platform binary from GitHub's release CDN, that
# download fails intermittently ("socket hang up"), and while the package was
# mandatory the failure took `npm ci` down with it. On Cloudflare Workers
# Builds -- which auto-installs before running any configured command and
# exposes no install command to retry -- that meant the build died before this
# script ever ran. npm's contract for an optional dependency is that the
# install proceeds without it, so the package may legitimately be absent here.
#
# SKIP, NEVER FAIL. A Worker deployed without symbolication is a small
# observability loss; a Worker that did not deploy is an outage. The same
# trade apps/ui's vite config makes for the same package. `--no-install` is
# what makes this a check rather than a download attempt: without it, npx
# would try to fetch the missing package from the network and hang the deploy
# on the very CDN this is routing around.
if [[ "$POSTHOG_ENABLED" == "true" ]] &&
  ! npx --no-install @posthog/cli --version >/dev/null 2>&1; then
  echo "warning: @posthog/cli is not installed (optional dependency, see" \
    "#10916); deploying WITHOUT sourcemap injection or upload." >&2
  POSTHOG_ENABLED=false
fi

# ...AND IT HAS TO REACH POSTHOG (#11421). The rule above is right and was
# applied to only half the ways this step fails: a MISSING cli skipped, but a
# cli that ran and could not reach the API took the deploy down with it, under
# `set -e`.
#
# That is not hypothetical. On 2026-08-17 every Workers Build in the account
# began failing at `posthog-cli sourcemap inject` with
#
#   WARN posthog_cli::api::releases: failed to get release from hash:
#     Request error: error sending request for url (https://us.i.posthog.com/...)
#   Failed: error occurred while running deploy command
#
# after a 30s timeout -- on three Workers, on unrelated branches (a renovate
# bump and a perf branch), and identically on a retrigger ten minutes later.
# The wrangler build had already SUCCEEDED in every one of them; the bytes were
# ready to ship. A third-party observability endpoint being unreachable had
# become an estate-wide deploy outage.
#
# So the same trade is applied to the same failure: run the two posthog phases
# tolerantly, and on ANY failure fall through to the plain deploy below. That
# path rebuilds from source, so a bundle half-injected by a failed `inject` is
# never what ships -- and no chunk id is stamped without a map behind it, which
# is the one outcome worse than no symbolication at all.
posthog_phase() {
  if "$@"; then
    return 0
  fi
  echo "warning: $1 failed (see #11421); deploying WITHOUT sourcemap" \
    "injection or upload. A Worker deployed without symbolication is a small" \
    "observability loss; a Worker that did not deploy is an outage." >&2
  return 1
}

if [[ "$POSTHOG_ENABLED" == "true" ]]; then
  # Phase 0: start from an empty $OUTDIR. `wrangler --outdir` writes into the
  # directory without clearing it, so anything left there from an earlier run
  # SURVIVES -- and phase 3 below resolves the bundle by globbing `*.js`, which
  # assumes exactly one match. A leftover .js (an entry renamed between builds,
  # a run that died mid-flight, or a `dist/` restored from Cloudflare Workers
  # Builds' build cache, which is enabled per-project and persists for 7 days)
  # turns that glob into two paths.
  #
  # Why that is worth a line of defence rather than a shrug: the failure is
  # SILENT and it corrupts symbolication specifically. `posthog-cli sourcemap
  # inject` stamps a chunk id into the bundle, phase 3 uploads the map under
  # that id, and phase 4 ships the file. Ship the wrong .js and PostHog happily
  # resolves stack traces against a map that describes different code -- line
  # numbers that point at real-looking, wrong source. That is worse than an
  # unsymbolicated trace, because nothing about it reads as broken.
  rm -rf "$OUTDIR"

  # Phase 1: build only -- writes $OUTDIR/<entry>.js(.map) without deploying
  # (see this file's own header comment for why a single combined build+
  # deploy command can't be injected into afterward).
  npx wrangler "${WRANGLER_SUBCOMMAND[@]}" \
    --config "$CONFIG" \
    --outdir "$OUTDIR" \
    --upload-source-maps \
    --message "$COMMIT_SHA" \
    --dry-run

  # Wrangler --no-bundle copies JS/WASM to --outdir but leaves external maps
  # in the custom build directory. Stage that complete build before PostHog
  # injects it, or none of the API Worker's 25 module maps would be uploaded.
  # Keep this separate from dist/api-modules: the final Wrangler invocation
  # runs the custom build again and must not overwrite the injected files.
  if [[ "$BASENAME" == "wrangler" ]]; then
    cp -R dist/api-modules/. "$OUTDIR/"
  fi

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
  if ! posthog_phase npx @posthog/cli sourcemap inject \
    --directory "$OUTDIR" \
    --release-name "$RELEASE_NAME" \
    --release-version "$RELEASE_VERSION"; then
    POSTHOG_ENABLED=false
  fi
fi

if [[ "$POSTHOG_ENABLED" == "true" ]]; then

  # Phases 3-4 below: upload the sourcemap, then ship the EXACT injected
  # file -- --no-bundle skips wrangler's
  # own esbuild step (which would otherwise rebuild from source and discard
  # the marker just injected above). ENTRY_JS is the single top-level entry;
  # the API Worker's deferred modules live under chunks/ and are collected by
  # find_additional_modules. Injection and upload both traverse the directory.
  # Resolve the entry by globbing since each config's main basename differs.
  ENTRY_JS=$(find "$OUTDIR" -maxdepth 1 -name '*.js')

  # Assert the single top-level entry. Phase 0 makes
  # a stale leftover impossible, so this covers the other half: wrangler
  # emitting more than one top-level entry (a future entry shape), or
  # none at all because the build silently produced nothing. Unguarded,
  # ENTRY_JS would become an empty or newline-joined string and get passed
  # straight to `wrangler deploy` in phase 4 -- which is the point where a
  # wrong or missing bundle would ship. Failing here costs a red build;
  # not failing costs mis-symbolicated traces nobody can tell are wrong.
  if [[ -z "$ENTRY_JS" || "$ENTRY_JS" == *$'\n'* ]]; then
    echo "deploy-worker-with-sourcemaps: expected exactly one .js in $OUTDIR, found:" >&2
    echo "${ENTRY_JS:-(none)}" >&2
    exit 1
  fi

  # Phase 3: upload the sourcemap BEFORE the deploy ships traffic. This
  # order is load-bearing: PostHog symbolicates at INGEST, so an error
  # captured in the seconds between a deploy and its map upload fails with
  # "No sourcemap uploaded for chunk id: ..." and stays minified forever --
  # and a fresh deploy is precisely when new-code errors (plus the
  # "Durable Object reset because its code was updated" wave every DO
  # deploy emits from in-flight work) are most likely. Both were observed
  # live on 2026-08-02's deploys. Uploading first is safe: the map + chunk
  # id are fully determined by phase 2's inject, and an upload for a deploy
  # that subsequently fails is inert (its chunk id never serves traffic).
  if ! posthog_phase npx @posthog/cli sourcemap upload \
    --directory "$OUTDIR" \
    --release-name "$RELEASE_NAME" \
    --release-version "$RELEASE_VERSION"; then
    POSTHOG_ENABLED=false
  fi
fi

if [[ "$POSTHOG_ENABLED" == "true" ]]; then
  # Phase 4: ship the EXACT injected bundle the map above describes.
  npx wrangler "${WRANGLER_SUBCOMMAND[@]}" \
    "$ENTRY_JS" \
    --config "$CONFIG" \
    --no-bundle \
    --message "$COMMIT_SHA"
else
  npx wrangler "${WRANGLER_SUBCOMMAND[@]}" \
    --config "$CONFIG" \
    --outdir "$OUTDIR" \
    --upload-source-maps \
    --message "$COMMIT_SHA"
fi
