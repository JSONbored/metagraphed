import { createShikiFactory } from "fumadocs-core/highlight/shiki";
import type { HighlighterCore } from "shiki/core";
import { createHighlighterCore, isSpecialLang } from "shiki/core";
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
/** What `HighlighterCore.loadLanguage` is DECLARED to take: registrations, and
 * the handful of special language names shiki resolves internally. Notably not
 * an arbitrary language name -- see acceptLanguageNames for who sends one
 * anyway. */
type LanguageArgument = Parameters<HighlighterCore["loadLanguage"]>[number];

/** A highlighter whose `loadLanguage` also takes a plain language NAME.
 *
 * The widened signature is the point, not an accident: it is what fumadocs
 * calls, and stating it here means a caller doing the same thing gets type
 * agreement rather than a cast that hides the mismatch. */
export type NameTolerantHighlighter = Omit<HighlighterCore, "loadLanguage"> & {
  loadLanguage(...langs: Array<LanguageArgument | string>): Promise<void>;
};

/**
 * Let `loadLanguage` accept a language NAME, which a core highlighter cannot.
 *
 * ## The bug this fixes
 *
 * Every code block on every /docs/api-reference page rendered UNHIGHLIGHTED in
 * production, and filed an unhandled `TypeError: Cannot read properties of
 * undefined (reading 'split')` while doing it. Measured on the deployed site,
 * reproduced against a local production build.
 *
 * `createHighlighterCore` has no language bundle, so its `loadLanguage` accepts
 * only REGISTRATIONS -- the grammar objects passed to `langs` above. Hand it a
 * string and it looks up a scope name it does not have, then calls
 * `.split('.')` on the `undefined` it got:
 *
 *     await core.loadLanguage("bash");   // throws, even though bash IS loaded
 *
 * And fumadocs' `highlightHast` (fumadocs-core/highlight/shiki) ALWAYS calls it
 * with a string:
 *
 *     if (!isSpecialLang(lang) && !(lang in getBundledLanguages())
 *         && !getLoadedLanguages().includes(lang)) lang = fallbackLanguage;
 *     await Promise.all([..., highlighter.loadLanguage(lang)]);
 *
 * That guard is written for a BUNDLED highlighter, where a name resolves
 * through the bundle. It correctly decides our language is fine -- it is in
 * `getLoadedLanguages()` -- and then makes the one call a core highlighter
 * cannot serve. So the highlight promise rejects for every block, and
 * `useShikiDynamic` leaves its Suspense placeholder in place forever: the raw
 * code, one bare `<span class="line">` per line, no tokens.
 *
 * ## Why the wrapper rather than a bundled highlighter
 *
 * `createHighlighter` from `shiki` is what fumadocs assumes, and it is exactly
 * what the header above explains this app cannot afford: it pulls all ~180
 * grammars into the module graph and OOMs the Nitro SSR pass. The incompatibility
 * is one method, so one method is what this adapts.
 *
 * A name we already hold is a NO-OP -- there is nothing to load -- which is
 * precisely what the bundled highlighter's own `loadLanguage` does for an
 * already-loaded language. Registration objects pass straight through. A name we
 * do not hold raises an error that NAMES it, rather than a TypeError about
 * `split`: fumadocs' guard rewrites an unknown language to `text` before it gets
 * here, so reaching that arm means this factory's language list is genuinely
 * missing something, and the message should say so.
 */
export function acceptLanguageNames(core: HighlighterCore): NameTolerantHighlighter {
  const loadRegistrations = core.loadLanguage.bind(core);
  const loadLanguage = async (...langs: Array<LanguageArgument | string>): Promise<void> => {
    // Split by what the core highlighter can actually take: a registration it
    // can register, versus a name it can only look up in a bundle it has not
    // got.
    const registrations: LanguageArgument[] = [];
    const names: string[] = [];
    for (const lang of langs) {
      if (typeof lang === "string") names.push(lang);
      else registrations.push(lang);
    }
    const loaded = core.getLoadedLanguages();
    const unknown = names.filter((name) => !isSpecialLang(name) && !loaded.includes(name));
    if (unknown.length > 0) {
      throw new Error(
        `openapi-shiki: no grammar registered for ${unknown.join(", ")}. ` +
          "Add it to the static imports in this file -- the OpenAPI page asks " +
          "for whatever language its code samples declare.",
      );
    }
    if (registrations.length === 0) return;
    await loadRegistrations(...registrations);
  };
  return Object.assign(core, { loadLanguage });
}

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
    return acceptLanguageNames(
      await createHighlighterCore({
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
      }),
    );
  },
});

export { openapiShikiFactory };
