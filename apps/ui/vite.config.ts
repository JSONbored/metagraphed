// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig, type LovableViteTanstackOptions } from "@lovable.dev/vite-tanstack-config";
import type { NitroPluginConfig } from "nitro/vite";
import mdx from "fumadocs-mdx/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";

// Cloudflare Workers Builds auto-injects this (no manual dashboard step) --
// confirmed via Cloudflare's own docs (workers/ci-cd/builds/configuration/,
// changelog/2025-06-10-default-env-vars/): "Passing current commit ID to
// error reporting, for example, Sentry" is its documented purpose. Absent
// locally/in PR CI, where it's simply undefined -- Sentry accepts an
// undefined release (just omits release tagging), not an error condition.
const commitSha = process.env.WORKERS_CI_COMMIT_SHA;

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
  // sentryVitePlugin is appended LAST (Sentry's own documented ordering
  // requirement -- "Put the Sentry vite plugin after all other plugins",
  // it needs to see every other plugin's final output to inject debug IDs
  // and produce accurate source maps) and returns an ARRAY of plugins
  // (spread, not pushed as a single entry). Verified empirically (real
  // `vite build` with no authToken) that this degrades gracefully to a
  // warning-only no-upload, not a build failure -- `disable` below is still
  // set explicitly so it's a true no-op (no plugin hooks run at all, no
  // telemetry ping) rather than relying on that fallback everywhere a token
  // isn't configured, i.e. every PR/local build today.
  plugins: [
    ...mdx(),
    ...sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      disable: !process.env.SENTRY_AUTH_TOKEN,
      telemetry: false,
      release: commitSha ? { name: commitSha } : undefined,
      // By default this plugin THROWS (failing the whole build) when an
      // upload genuinely fails with a token present -- a different failure
      // mode than the graceful warn-and-skip when no token exists at all.
      // A transient Sentry API hiccup or an expired token must never block
      // shipping real product code -- the same tolerant-by-design principle
      // already applied to every box-side observability integration in
      // this rollout (e.g. scripts/refresh-native-snapshot.ts's own
      // comment: "a transient chain RPC failure must not block the
      // publish").
      errorHandler: (err) => {
        console.warn("[sentry-vite-plugin] source map upload failed:", err);
      },
      sourcemaps: {
        // Uploaded to Sentry, then stripped from the deployed output --
        // don't publicly serve the app's own source maps alongside the
        // built JS.
        filesToDeleteAfterUpload: ["**/*.js.map"],
      },
    }),
  ],
  // `vite: { ... }` is this preset's own documented passthrough for plain
  // Vite options beyond plugins (see the header comment above) --
  // sourcemap generation must be on for sentryVitePlugin to have anything
  // to upload, and `define` bridges WORKERS_CI_COMMIT_SHA (a build-time-
  // only process.env var, not exposed to browser code) into
  // import.meta.env.VITE_SENTRY_RELEASE, the same client-exposed-env-var
  // convention src/lib/error-reporting.ts's existing VITE_SENTRY_DSN read
  // already uses -- the preset's own "VITE_* env injection" (see the header
  // comment) only covers vars already present in an actual .env file /
  // process.env at that name, not one bridged in from a differently-named
  // source like this.
  vite: {
    build: { sourcemap: true },
    define: {
      "import.meta.env.VITE_SENTRY_RELEASE": JSON.stringify(commitSha ?? ""),
    },
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
