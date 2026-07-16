// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig, type LovableViteTanstackOptions } from "@lovable.dev/vite-tanstack-config";
import type { NitroPluginConfig } from "nitro/vite";
import mdx from "fumadocs-mdx/vite";

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
  plugins: [...mdx()],
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
      },
    },
  } satisfies NitroPluginConfig as unknown as LovableViteTanstackOptions["nitro"],
});
