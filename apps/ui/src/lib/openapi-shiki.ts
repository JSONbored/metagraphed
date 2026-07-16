import { createShikiFactory } from "fumadocs-core/highlight/shiki";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// fumadocs-openapi's default shiki factory (fumadocs-core/highlight/shiki/full,
// used automatically by createOpenAPIPage() when no `shiki` option is passed)
// does an unrestricted `import("shiki")` -- pulling every one of shiki's
// ~180 bundled language grammars into the module graph. Fine for the client
// build (Vite code-splits each into its own lazy chunk, only fetched on
// demand), fatal for the Nitro cloudflare-module SSR bundle: that pass has
// to trace and hold the WHOLE graph in memory to produce a single
// deployable Worker. Confirmed via a local repro constraining Node to the
// same ~2GB heap Cloudflare Workers Builds' container OOM's at ("FATAL
// ERROR: ... JavaScript heap out of memory" during the "nitro environment"
// build pass specifically, on every commit of this PR back to its first).
//
// Fixed with explicit static imports of only the languages this app's
// interactive OpenAPIPage playground ever actually requests:
// requests/generators/all.js's 7 fixed code-sample languages (bash/js/go/
// python/java/csharp/rust) plus json (request/response body preview).
// Static imports (not the catalog-keyed dynamic lookup defaultShikiFactory
// uses) mean Rollup can prove nothing else is reachable and excludes the
// rest of shiki's language/theme catalog entirely -- verified by re-running
// the same constrained-heap repro against this factory: build succeeds.
const openapiShikiFactory = createShikiFactory({
  async init() {
    const [bash, javascript, go, python, java, csharp, rust, json, githubLight, githubDark] =
      await Promise.all([
        import("shiki/langs/bash.mjs"),
        import("shiki/langs/javascript.mjs"),
        import("shiki/langs/go.mjs"),
        import("shiki/langs/python.mjs"),
        import("shiki/langs/java.mjs"),
        import("shiki/langs/csharp.mjs"),
        import("shiki/langs/rust.mjs"),
        import("shiki/langs/json.mjs"),
        import("shiki/themes/github-light.mjs"),
        import("shiki/themes/github-dark.mjs"),
      ]);
    return createHighlighterCore({
      langs: [
        bash.default,
        javascript.default,
        go.default,
        python.default,
        java.default,
        csharp.default,
        rust.default,
        json.default,
      ],
      // Matches createOpenAPIPageBase's own default shikiOptions.themes
      // (fumadocs-openapi/ui/base.js) -- same visual result, scoped set.
      themes: [githubLight.default, githubDark.default],
      engine: createJavaScriptRegexEngine(),
    });
  },
});

export { openapiShikiFactory };
