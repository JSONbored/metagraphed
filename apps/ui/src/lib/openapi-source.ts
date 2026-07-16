import { createOpenAPI } from "fumadocs-openapi/server";

// Same unwrapped spec URL scripts/generate-openapi-docs.mjs bakes into every
// generated content/docs/api-reference/**/*.mdx page's `_openapi.preload`
// frontmatter -- kept as a literal here (not imported from the generator
// script) since this module runs in the app itself, the generator in a
// standalone Node process.
const LIVE_SPEC_URL = "https://api.metagraph.sh/metagraph/openapi.json";

// The spec's `summary` field holds full explanatory paragraphs (up to
// ~1100 chars) with `description` left empty on every operation.
// fumadocs-openapi's own <APIPage/> internals independently re-derive a
// title from `operation.summary` at render time (operation/index.js:
// `operation.summary || pathItem.summary || idToTitle(...)`), so this
// runtime-fetched copy needs the same fix scripts/generate-openapi-docs.mjs
// applies to the one baked into each generated page's frontmatter --
// duplicated rather than shared (that script is a standalone Node process,
// this module runs inside the Vite/TanStack app build).
const WORD_OVERRIDES: Record<string, string> = {
  api: "API",
  rpc: "RPC",
  id: "ID",
  ss58: "SS58",
  d1: "D1",
  hhi: "HHI",
  ai: "AI",
  url: "URL",
  json: "JSON",
  tao: "TAO",
  ohlc: "OHLC",
  dx: "DX",
};

function humanizeOperationId(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => WORD_OVERRIDES[w.toLowerCase()] ?? w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

interface OpenAPIOperationLike {
  operationId?: string;
  summary?: string;
  description?: string;
}

function splitOperationSummaries(spec: { paths?: Record<string, Record<string, unknown>> }): void {
  for (const methods of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(methods)) {
      const operation = op as OpenAPIOperationLike;
      if (!operation || typeof operation !== "object" || !operation.operationId) continue;
      const summary = operation.summary ?? "";
      if (summary.length <= 80) continue;
      if (!operation.description) operation.description = summary;
      operation.summary = humanizeOperationId(operation.operationId);
    }
  }
}

async function fetchSpec() {
  const res = await fetch(LIVE_SPEC_URL);
  const spec = await res.json();
  splitOperationSummaries(spec);
  return spec;
}

// Shared instance -- docs-source.ts registers openapi.loaderPlugin() so
// Fumadocs' page tree understands `_openapi`-flavored pages, and
// docs.$.tsx's server loader calls openapi.preloadOpenAPIPage(page) to
// resolve a page's `document` reference into real bundled schema data
// before the client ever renders <APIPage />. "metagraph" (not the raw
// URL) is the schema key -- must match scripts/generate-openapi-docs.mjs's
// own createOpenAPI() call exactly, since preloadOpenAPIPage resolves each
// generated page's `document` prop by looking up this same key.
export const openapi = createOpenAPI({ input: { metagraph: fetchSpec } });
