// Generates content/docs/api-reference/**/*.mdx from the published OpenAPI
// spec -- one page per operation, grouped into per-tag folders (Planets/
// Celestial Bodies-style, per the fumadocs-openapi Scalar Galaxy example
// this mirrors). Committed generated output, same convention as
// routeTree.gen.ts and openapi.json's own generated types -- re-run this
// after the OpenAPI spec changes:
//
//   node scripts/generate-openapi-docs.mjs
//
// Two things learned empirically, not documented anywhere obvious:
// - fumadocs-openapi's own `groupBy: "tag"` option (v11.2.1) produces zero
//   files against this spec -- a silent no-op, no error. Grouping is done
//   as a post-process instead: generate flat, then move each file into a
//   folder keyed by the operation's primary tag read directly from the spec.
// - The generated <APIPage document="…" /> prop is resolved CLIENT-SIDE (a
//   real fetch, not a build-time bundle) in this app's TanStack Start +
//   fumadocs-mdx content-collections setup, unlike the Next.js templates
//   fumadocs-openapi's own docs assume. A relative file path there 404s
//   silently, producing "Cannot read properties of undefined (reading
//   'bundled')" -- needs a URL the browser can fetch at request time.
// - /api/v1/openapi.json (the URL /schemas' CopyableCode shows users) wraps
//   the spec in this API's standard {ok, data, meta} response envelope --
//   fine for a human copying a curl command, useless as a raw OpenAPI
//   document source. /metagraph/openapi.json (a static asset, not an /api/v1
//   route) serves the same spec unwrapped -- verified via a direct fetch
//   (top-level keys: openapi/info/paths/…, not ok/data/meta) -- and is what
//   this script and every generated page's `document` prop use instead.
// - The spec's `summary` field holds full explanatory sentences/paragraphs
//   on every operation (24-1100 chars) with `description` left empty --
//   fumadocs-openapi uses `summary` as the page title verbatim (no
//   truncation), and that title is what this app's docs.$.tsx renders as
//   the sidebar label, breadcrumb, H1, and browser tab. splitOperationSummaries()
//   below fixes this at the source for every operation, not just the
//   longest ones (a sidebar mixing short-but-still-sentence-length titles
//   next to properly-short ones reads as inconsistent): derives a short
//   Title Case title from the operationId, and moves the original text to
//   `description` (rendered by <DocsDescription>, right under the H1 --
//   same layout the 4 hand-written docs pages already use). Applied twice,
//   independently, once here (bakes the fix into the generated frontmatter)
//   and once in src/lib/openapi-source.ts (fumadocs-openapi's own <APIPage/>
//   internals independently re-derive a title from `operation.summary` at
//   render time too -- see operation/index.js's `operation.summary ||
//   pathItem.summary || idToTitle(...)` -- so the runtime-fetched copy of
//   the spec needs the same fix, not just the one baked into frontmatter).
import { readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { generateFiles } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";

const OUTPUT_DIR = process.env.OPENAPI_DOCS_OUTPUT ?? "./content/docs/api-reference";
// Read locally (fast, no network dependency for a rarely-changing generator
// script). src/lib/openapi-source.ts's runtime instance fetches the same
// spec from its own LIVE_SPEC_URL (the live, unwrapped equivalent) instead
// -- see that file for why, and for the single source of truth on the
// actual domain (this script can't import it directly -- a standalone Node
// process, not part of the Vite/TS build).
const LOCAL_SPEC_PATH = "../../public/metagraph/openapi.json";

// Acronyms/initialisms that Title-Case-per-camelCase-word gets wrong
// (e.g. "rpcEndpoints" -> "Rpc Endpoints" instead of "RPC Endpoints").
// Matched case-insensitively per word; anything not listed here just stays
// Title Case, which is a fine default for ordinary words.
const WORD_OVERRIDES = {
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
const ID_OVERRIDES = {
  openapi: "OpenAPI",
};

/** "accountAxonRemovals" -> "Account Axon Removals"; "rpcEndpoints" -> "RPC Endpoints". */
function humanizeOperationId(id) {
  if (ID_OVERRIDES[id]) return ID_OVERRIDES[id];
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => WORD_OVERRIDES[w.toLowerCase()] ?? w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** "accountAxonRemovals" -> "account-axon-removals" (a URL slug/filename, not a title). */
function kebabCase(id) {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Za-z])([0-9])/g, "$1-$2")
    .toLowerCase();
}

/**
 * Mutates a parsed OpenAPI document in place: for every operation, swaps in
 * a short operationId-derived title and moves the original summary text to
 * `description` (only if `description` isn't already set -- never
 * overwrites real data). Applied unconditionally, not just to the longest
 * summaries -- a sidebar mixing "Account Axon Removals" next to "Fetch
 * Bittensor RPC endpoint status." (a 37-char summary, technically short,
 * but still a full sentence that wraps across lines as a nav item) reads as
 * inconsistent; every title in the reference should follow the same short,
 * Title Case pattern.
 */
function splitOperationSummaries(spec) {
  for (const methods of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(methods)) {
      if (!op || typeof op !== "object" || !op.operationId) continue;
      const summary = op.summary ?? "";
      if (!summary) continue;
      if (!op.description) op.description = summary;
      op.summary = humanizeOperationId(op.operationId);
    }
  }
  return spec;
}

// Most operations carry a second, catch-all "analytics" tag alongside their
// real domain tag (e.g. accountsList: ["accounts", "analytics"]) -- grouping
// by first-tag-that-isn't-this avoids dumping ~90 unrelated operations into
// one "Analytics" folder.
const CATCH_ALL_TAG = "analytics";

const TAG_TITLE_OVERRIDES = {
  rpc: "RPC",
  "api-dx": "API DX",
};

function tagTitle(tag) {
  return (
    TAG_TITLE_OVERRIDES[tag] ??
    tag
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ")
  );
}

function primaryTag(tags) {
  if (!tags || tags.length === 0) return "misc";
  return tags.find((t) => t !== CATCH_ALL_TAG) ?? tags[0];
}

async function main() {
  // path.resolve (CWD-relative) -- this script always runs as
  // `node scripts/generate-openapi-docs.mjs` from apps/ui/.
  const spec = JSON.parse(await readFile(path.resolve(LOCAL_SPEC_PATH), "utf8"));
  const tagByOperationId = new Map();
  for (const methods of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(methods)) {
      if (op && typeof op === "object" && op.operationId) {
        tagByOperationId.set(op.operationId, primaryTag(op.tags));
      }
    }
  }
  splitOperationSummaries(spec);

  // index.mdx is hand-authored (a landing page, not generated), but lives
  // inside OUTPUT_DIR alongside the generated tree -- preserve it across
  // the rm -rf below rather than requiring every regeneration to remember
  // to restore it by hand.
  const indexPath = path.join(OUTPUT_DIR, "index.mdx");
  const indexContent = await readFile(indexPath, "utf8").catch(() => null);

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  if (indexContent !== null) await writeFile(indexPath, indexContent);

  // "metagraph" (not the raw URL) is the schema key from here on -- must
  // match src/lib/openapi-source.ts's runtime instance exactly, since
  // openapi.preloadOpenAPIPage(page) resolves a page's `document` prop
  // (baked into each generated file below) by looking up this same key.
  const openapi = createOpenAPI({ input: { metagraph: () => spec } });
  await generateFiles({
    input: openapi,
    output: OUTPUT_DIR,
    per: "operation",
    meta: false,
    // Renders `operation.description` (the full original summary text,
    // post-split) as proper body Markdown inside <APIPage/> itself, not
    // frontmatter `description` -- Fumadocs' own <DocsDescription/> is a
    // `text-lg` one-line subtitle treatment, wrong for multi-sentence prose.
    // See operation/index.js's `showDescription && operationDescription &&
    // <Markdown md={operationDescription} />` -- confirmed in source, not
    // assumed.
    includeDescription: true,
  });

  const entries = await readdir(OUTPUT_DIR);
  const pagesByTag = new Map();

  for (const entry of entries) {
    if (!entry.endsWith(".mdx") || entry === "index.mdx") continue;
    const operationId = entry.slice(0, -".mdx".length);
    const tag = tagByOperationId.get(operationId) ?? "misc";
    // kebab-case, not the raw camelCase operationId -- this app's site-wide
    // breadcrumb (breadcrumb-nav.ts) renders each URL path segment verbatim,
    // uppercased, with no word-splitting. "accountAxonRemovals" reads as an
    // unbroken wall of caps; "account-axon-removals" reads as separate
    // words even uppercased, matching the existing "/docs/chain-events"
    // convention.
    const slug = kebabCase(operationId);
    const fileName = `${slug}.mdx`;

    const tagDir = path.join(OUTPUT_DIR, tag);
    await mkdir(tagDir, { recursive: true });

    const from = path.join(OUTPUT_DIR, entry);
    const to = path.join(tagDir, fileName);
    await rm(to, { force: true });
    await writeFile(to, await readFile(from, "utf8"));
    await rm(from);

    if (!pagesByTag.has(tag)) pagesByTag.set(tag, []);
    pagesByTag.get(tag).push(slug);
  }

  for (const [tag, pages] of pagesByTag) {
    await writeFile(
      path.join(OUTPUT_DIR, tag, "meta.json"),
      JSON.stringify({ title: tagTitle(tag), pages: pages.sort() }, null, 2) + "\n",
    );
  }

  const tagOrder = [...pagesByTag.keys()].sort();
  await writeFile(
    path.join(OUTPUT_DIR, "meta.json"),
    JSON.stringify({ title: "API reference", pages: ["index", ...tagOrder] }, null, 2) + "\n",
  );

  const total = [...pagesByTag.values()].reduce((sum, pages) => sum + pages.length, 0);
  console.log(`Generated ${total} operation pages across ${tagOrder.length} tags.`);
}

await main();
