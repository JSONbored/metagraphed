import { createOpenAPI } from "fumadocs-openapi/server";
import { DEFAULT_API_BASE } from "@/lib/metagraphed/config";

// Same unwrapped spec URL scripts/generate-openapi-docs.mjs bakes into every
// generated content/docs/api-reference/**/*.mdx page's `_openapi.preload`
// frontmatter -- derived from DEFAULT_API_BASE (not the runtime-overridable
// getApiBase()/API_BASE) rather than a second hardcoded domain literal, so
// there's one source of truth for it. The generator script can't share this
// constant directly (a standalone Node process, not part of the Vite/TS
// build), so its own comment references this file by name instead of
// repeating the literal string.
const LIVE_SPEC_URL = `${DEFAULT_API_BASE}/metagraph/openapi.json`;

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

// Whole-operationId overrides for cases the camelCase splitter can't catch
// -- an acronym only recognizable as a *substring* of a single-word,
// all-lowercase operationId (no camelCase boundary to split on at all).
const ID_OVERRIDES: Record<string, string> = {
  openapi: "OpenAPI",
};

function humanizeOperationId(id: string): string {
  if (ID_OVERRIDES[id]) return ID_OVERRIDES[id];
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

// Applied unconditionally, not just to the longest summaries -- a sidebar
// mixing "Account Axon Removals" next to "Fetch Bittensor RPC endpoint
// status." (a 37-char summary, technically short, but still a full
// sentence that wraps across lines as a nav item) reads as inconsistent;
// every title in the reference should follow the same short, Title Case
// pattern. Kept in sync with scripts/generate-openapi-docs.mjs's twin.
function splitOperationSummaries(spec: { paths?: Record<string, Record<string, unknown>> }): void {
  for (const methods of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(methods)) {
      const operation = op as OpenAPIOperationLike;
      if (!operation || typeof operation !== "object" || !operation.operationId) continue;
      const summary = operation.summary ?? "";
      if (!summary) continue;
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
