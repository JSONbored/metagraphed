// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig, type LovableViteTanstackOptions } from "@lovable.dev/vite-tanstack-config";
import type { NitroPluginConfig } from "nitro/vite";
import type { NormalizedOutputOptions, OutputBundle, Plugin, PluginContext } from "rollup";
import mdx from "fumadocs-mdx/vite";
import posthogRollupPlugin from "@posthog/rollup-plugin";

// Cloudflare Workers Builds auto-injects this (no manual dashboard step) --
// confirmed via Cloudflare's own docs (workers/ci-cd/builds/configuration/,
// changelog/2025-06-10-default-env-vars/): "Passing current commit ID to
// error reporting, for example, Sentry" is its documented purpose (Sentry
// itself is fully removed here, #7766 -- Cloudflare's own doc wording is
// just what it is). Used below as posthogRollupPlugin's sourcemap
// `releaseName` -- undefined locally/in PR CI, where sourcemaps.enabled is
// already false anyway.
const commitSha = process.env.WORKERS_CI_COMMIT_SHA;

// @posthog/rollup-plugin's own `writeBundle` hook (the step that actually
// uploads source maps, node_modules/@posthog/rollup-plugin/src/index.ts) has
// NO `errorHandler` option, unlike sentryVitePlugin above -- a rejected
// upload (network blip, expired personal API key, missing `posthog-cli`
// binary -- confirmed via @posthog/plugin-utils' spawnLocal, which rejects
// on any non-zero exit code) propagates straight out of the hook and fails
// the ENTIRE build. Wrap the returned plugin's handler in the same
// tolerant warn-and-continue behavior sentryVitePlugin gets for free via its
// own `errorHandler`, so a PostHog-side hiccup can never block a real deploy.
function withTolerantSourcemapUpload(plugin: Plugin): Plugin {
  const writeBundle = plugin.writeBundle;
  if (typeof writeBundle !== "object" || writeBundle === null) return plugin;
  const originalHandler = writeBundle.handler as (
    this: PluginContext,
    options: NormalizedOutputOptions,
    bundle: OutputBundle,
  ) => void | Promise<void>;
  return {
    ...plugin,
    writeBundle: {
      ...writeBundle,
      async handler(this: PluginContext, options: NormalizedOutputOptions, bundle: OutputBundle) {
        try {
          await originalHandler.call(this, options, bundle);
        } catch (err) {
          console.warn("[posthog-rollup-plugin] source map upload failed:", err);
        }
      },
    },
  };
}

// POSTHOG_API_KEY (a personal API key, NOT the VITE_POSTHOG_PROJECT_TOKEN
// client-side ingest token from src/lib/analytics.ts -- that one is
// write-only/public-safe, this one is a real secret with read access) and
// POSTHOG_PROJECT_ID gate sourcemap upload: both env vars must be present, or
// this stays a true no-op. Explicit `sourcemaps.enabled` (rather than relying
// on @posthog/plugin-utils' own default) is load-bearing here -- resolveConfig
// THROWS SYNCHRONOUSLY at plugin-construction time (i.e. this very module's
// eval, not a lazy build step) when sourcemaps default-enable with either
// value missing (node_modules/@posthog/plugin-utils/src/config.ts), which
// would otherwise break every unconfigured build (every PR/local dev today).
const posthogApiKey = process.env.POSTHOG_API_KEY;
const posthogProjectId = process.env.POSTHOG_PROJECT_ID;
const posthogSourcemapsEnabled = Boolean(posthogApiKey && posthogProjectId);

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  // fumadocs-mdx's Vite plugin is added via the top-level `plugins` option
  // (not nested inside `vite: { plugins: [...] }`) -- the preset appends
  // `options.plugins` to its own internal plugin list before the `vite`
  // passthrough is merged in, so this is the documented extension point for
  // genuinely new plugins, as opposed to the ones already registered by the
  // preset itself (see the header comment above). Pattern proven working
  // (dev + a real Cloudflare production build) in JSONbored/loopover's
  // identical @lovable.dev/vite-tanstack-config setup, PR #6271.
  //
  // sentryVitePlugin (build-time sourcemap upload) was removed here once
  // PostHog's posthogRollupPlugin below became the sole sourcemap uploader
  // (Sentry's own runtime error capture, src/lib/error-reporting.ts's
  // `@sentry/browser` sink, is also fully removed now -- #7766).
  plugins: [
    ...mdx(),
    // PostHog error tracking (metagraphed#7759) source-map upload, wrapped
    // for the two build-safety gaps documented above this file's
    // `posthogSourcemapsEnabled` const.
    withTolerantSourcemapUpload(
      posthogRollupPlugin({
        personalApiKey: posthogApiKey ?? "",
        projectId: posthogProjectId,
        sourcemaps: {
          enabled: posthogSourcemapsEnabled,
          // Stable name + per-deploy version, matching the Worker deploys'
          // convention (scripts/deploy-worker-with-sourcemaps.sh passes
          // metagraphed-<config> / <sha>). Passing the SHA as releaseName
          // made every deploy its own one-off "project" in PostHog's release
          // UI instead of versions of one app. commitSha is undefined
          // locally/in PR CI, where sourcemaps.enabled is already false.
          releaseName: "metagraphed-ui",
          releaseVersion: commitSha,
          // Same "don't publicly serve the app's own source maps" rationale
          // as Sentry's filesToDeleteAfterUpload above -- this plugin's own
          // equivalent option (config.ts's `deleteAfterUpload`, defaults
          // true) already matches, set explicitly so the intent is documented
          // here rather than relying on an unstated default.
          deleteAfterUpload: true,
        },
      }),
    ),
  ],
  // `vite: { ... }` is this preset's own documented passthrough for plain
  // Vite options beyond plugins (see the header comment above) --
  // sourcemap generation must be on for posthogRollupPlugin to have anything
  // to upload. metagraphed#7766: the `define` block that used to bridge
  // WORKERS_CI_COMMIT_SHA into import.meta.env.VITE_SENTRY_RELEASE for the
  // runtime Sentry SDK's release tag is gone -- no client-side code reads a
  // release/commit value anymore now that Sentry's runtime capture is
  // removed; commitSha above is still used directly (Node-side, no bridge
  // needed) as posthogRollupPlugin's own `releaseName`.
  vite: {
    build: { sourcemap: true },
  },
  // Force-enable the nitro deploy plugin. By default it only runs inside
  // Lovable's CI ("No Lovable context detected — skipping nitro deploy
  // plugin"), so every other builder — crucially Cloudflare Workers Builds —
  // produced no dist/server/wrangler.json, and `wrangler deploy` failed with
  // ENOENT. That broke production deploys: metagraph.sh kept serving a stale
  // build while merged PRs never shipped. Forcing it on generates the
  // cloudflare worker bundle + merged wrangler.json everywhere.
  //
  // #5236: @polkadot/extension-dapp is only ever reached via a dynamic
  // import() inside a client-only function body (lib/metagraphed/
  // wallet-injected.ts), guarded by `typeof window === "undefined"` — never
  // executed during SSR or in the actual Nitro build output. But Nitro drives
  // its OWN Rollup build for the deployed server bundle (a third Vite
  // "environment" alongside client/ssr, confirmed via node_modules/nitro/dist/
  // vite.mjs), which still walks the dynamic-import graph to resolve it for
  // chunking purposes — and one of its transitive deps
  // (@polkadot/x-textdecoder) has a package exports map Rollup's resolver
  // can't parse, hard-failing the build (confirmed live 2026-07-14) even
  // though the code path is unreachable at runtime. A top-level
  // `vite: { ssr: { external } }` does NOT reach this Nitro-specific build
  // step (confirmed by testing — same failure persisted).
  //
  // A plain top-level `nitro: { rollupConfig: { external: fn } }` also isn't
  // safe here: the cloudflare-module preset sets up its OWN externals for
  // Cloudflare/Node builtins (`cloudflare:workers`, etc.) via a `unenv`-based
  // mechanism inside its `build:before` hook (enableNodeCompat,
  // node_modules/nitro/dist/_presets.mjs) — a raw config-level `external`
  // fully REPLACES that rather than composing with it (confirmed live: doing
  // so broke `cloudflare:workers` resolution, a real regression). The
  // `rollup:before` hook fires immediately before the actual Rollup call, once
  // every preset/module hook (including the unenv one) has already finished
  // configuring `rollupConfig.external` — wrapping the value already sitting
  // there at that point, instead of setting it earlier, preserves everything
  // Nitro itself needs while adding the one exception this feature needs.
  // Matching by prefix rather than an explicit package list so a transitive
  // @polkadot/* addition later (e.g. #5237's own @polkadot/api usage) doesn't
  // silently reintroduce this same failure.
  //
  // @lovable.dev/vite-tanstack-config's own `nitro` option type is a
  // deliberately narrow subset (preset/output/cloudflare only — see its own
  // doc comment: "File an issue if you need more") that doesn't expose
  // `hooks`, even though the value is passed straight through to nitro/vite's
  // real `nitro()` plugin, which does support it. Cast through the actual
  // upstream `NitroPluginConfig` type rather than `any` so this stays
  // type-checked against Nitro's real config shape.
  nitro: {
    hooks: {
      "rollup:before": (_nitro, rollupConfig) => {
        const prevExternal = rollupConfig.external;
        rollupConfig.external = (id: string, parentId: string | undefined, isResolved: boolean) => {
          if (id.startsWith("@polkadot/")) return true;
          if (typeof prevExternal === "function") return prevExternal(id, parentId, isResolved);
          if (Array.isArray(prevExternal)) return prevExternal.includes(id);
          return false;
        };

        // #6210/#6257: fumadocs-openapi and its @fumadocs/api-docs dependency
        // each vendor their own copies of small CJS deps (@fastify/deepmerge,
        // xml-js, fast-content-type-parse, ...) under their own dist/
        // node_modules, built by rolldown with a shared per-package
        // "_virtual/_rolldown/runtime.js" CJS-interop helper (__commonJSMin)
        // that the vendored deps' wrapper functions call back into. Nitro's
        // default manualChunks puts every node_modules package in its own
        // chunk by name, splitting each vendored dep from the runtime helper
        // it depends on. Under Node/`vite preview` this happened to still
        // work; under workerd's strict ESM evaluation order it doesn't --
        // whichever chunk evaluates second sees the other's export as
        // undefined, throwing "__commonJSMin is not a function" and crashing
        // worker init for every route (this actually shipped to production
        // and took the whole site down -- see the #6257 incident writeup).
        // Force this entire package tree into one physical chunk so no
        // cross-chunk split between a vendored dep and its interop helper can
        // happen; every other package keeps its default per-package chunk.
        const outputConfig = rollupConfig.output;
        const prevManualChunks =
          outputConfig && !Array.isArray(outputConfig) ? outputConfig.manualChunks : undefined;
        if (
          outputConfig &&
          !Array.isArray(outputConfig) &&
          typeof prevManualChunks === "function"
        ) {
          outputConfig.manualChunks = (id: string, meta) => {
            if (id.includes("/fumadocs-openapi/") || id.includes("/@fumadocs/api-docs/")) {
              return "_libs/fumadocs-openapi-vendor";
            }
            return prevManualChunks(id, meta);
          };
        }
      },
    },
  } satisfies NitroPluginConfig as unknown as LovableViteTanstackOptions["nitro"],
});
