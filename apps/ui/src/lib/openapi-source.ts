import { createOpenAPI } from "fumadocs-openapi/server";

// Same unwrapped spec URL scripts/generate-openapi-docs.mjs bakes into every
// generated content/docs/api-reference/**/*.mdx page's `_openapi.preload`
// frontmatter -- kept as a literal here (not imported from the generator
// script) since this module runs in the app itself, the generator in a
// standalone Node process.
const LIVE_SPEC_URL = "https://api.metagraph.sh/metagraph/openapi.json";

// Shared instance -- docs-source.ts registers openapi.loaderPlugin() so
// Fumadocs' page tree understands `_openapi`-flavored pages, and
// docs.$.tsx's server loader calls openapi.preloadOpenAPIPage(page) to
// resolve a page's `document` reference into real bundled schema data
// before the client ever renders <APIPage />.
export const openapi = createOpenAPI({ input: [LIVE_SPEC_URL] });
