// Generates content/docs/api-reference/**/*.mdx from the published OpenAPI
// spec -- one page per operation, grouped into per-tag folders (Planets/
// Celestial Bodies-style, per the fumadocs-openapi Scalar Galaxy example
// this mirrors). Committed generated output, same convention as
// routeTree.gen.ts and openapi.json's own generated types -- re-run this
// after the OpenAPI spec changes:
//
//   node scripts/generate-openapi-docs.ts
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
import { clampText } from "../src/lib/metagraphed/truncate.ts";

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

/** First sentence of a description, for a one-line entry in a group index. */
function firstSentence(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const end = flat.search(/\.\s|\.$/);
  return end === -1 ? flat : flat.slice(0, end + 1);
}

/**
 * Google truncates a description around 155-160 characters, and the spec's
 * first sentences run to 604 (median 169, 157 of 290 over budget).
 */
const META_DESCRIPTION_MAX = 155;

/** Below this, the route is dropped rather than crushing the prose. */
const MIN_PROSE_BUDGET = 60;

/**
 * The `<meta name="description">` for one operation page.
 *
 * A SEPARATE frontmatter key from `description`, deliberately. `description` is
 * rendered by Fumadocs' <DocsDescription> as a one-line `text-lg` subtitle, and
 * the operation's prose is already rendered in full inside <APIPage/> (see
 * `includeDescription` below) -- putting it in both paints the first sentence
 * twice, once as a subtitle and again as the first line of the body.
 *
 * Leaving it out entirely was the status quo, and it meant all 290 generated
 * pages shipped `<meta name="description" content="">`: an EMPTY description,
 * which is worse than none, on 83% of the docs and on exactly the pages that
 * answer "how do I call this". Measured on the live site 2026-08-15.
 *
 * The method and route go in because a pasted-route query is one of the things
 * Search Console shows actually finding this site, and because the route is the
 * one part of an API-reference description guaranteed to be unique.
 */
function metaDescription(op, method, route) {
  const suffix = `${method.toUpperCase()} ${route}`;
  // Backticks are markdown for the BODY prose; a meta description is plain
  // text, so `application/feed+json` renders with the backticks visible in the
  // search result. 33 of the 290 carried them. Angle brackets stay -- they are
  // placeholder syntax (`?counterparty=<ss58>`), not formatting.
  const prose = firstSentence(op.description ?? "").replace(/`/g, "");
  if (!prose) return clampText(suffix, META_DESCRIPTION_MAX);
  // Room is RESERVED for the route rather than the route being appended if it
  // happens to fit: appending left 54% of pages with it and 46% without, a
  // split driven by nothing but how long that operation's first sentence ran.
  const proseBudget = META_DESCRIPTION_MAX - suffix.length - 1;
  // Unless the route is so long that keeping it would crush the prose, which is
  // the half that actually describes the endpoint.
  if (proseBudget < MIN_PROSE_BUDGET) return clampText(prose, META_DESCRIPTION_MAX);
  return `${clampText(prose, proseBudget)} ${suffix}`;
}

/**
 * Add `metaDescription` to a generated page's frontmatter.
 *
 * Inserted after the opening `---` so it cannot land inside the nested
 * `_openapi:` block, where it would be read as part of that object rather than
 * as a top-level key. Quoted and escaped as a YAML double-quoted scalar --
 * these sentences contain `:` and `"` routinely.
 */
function withMetaDescription(content, description) {
  if (!description || !content.startsWith("---\n")) return content;
  const escaped = description.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `---\nmetaDescription: "${escaped}"\n${content.slice("---\n".length)}`;
}

/**
 * Escape the two characters MDX treats as syntax, for prose taken from the spec.
 *
 * Operation descriptions are written for an API reference, not for MDX, and they
 * are full of both: `?counterparty=<ss58>` parses as an unclosed JSX tag and
 * `{network}` as a JS expression. Either one fails the build outright — which is
 * how this was caught, rather than by rendering wrongly in production.
 */
function escapeMdx(text) {
  return String(text).replace(/([<{])/g, "\\$1");
}

/**
 * The index page for one tag folder (#11204).
 *
 * WHY THIS IS GENERATED, not hand-written: every operation page links its own
 * group path (`/docs/api-reference/accounts`) in the docs navigation, and those
 * 27 paths had no page behind them — they 404'd. So the docs shipped ~300
 * internal links to 404s, a reader clicking a sidebar category got an error,
 * and the site-wide BreadcrumbList (#11230) named those URLs as crumb targets,
 * which Google validates.
 *
 * Generating it means a new API tag gets its index automatically, rather than
 * silently reintroducing the same 404 the next time the spec grows a group.
 *
 * It is a real page, not a stub: every operation in the group with its title,
 * method, path and first line of prose. That also flattens the docs tree —
 * before this, reaching some reference pages took eleven hops from /docs.
 */
function tagIndexPage(tag, operations) {
  const title = tagTitle(tag);
  const rows = [...operations]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((op) => {
      // The method+path needs no escaping — it is inside a code span, where MDX
      // does not parse JSX. The description is bare prose and does.
      const line = `- [${escapeMdx(op.title)}](/docs/api-reference/${tag}/${op.slug}) — \`${op.method} ${op.route}\``;
      return op.description ? `${line}  \n  ${escapeMdx(op.description)}` : line;
    })
    .join("\n");
  return (
    `---\n` +
    `title: ${title}\n` +
    `description: Every ${title} endpoint in the metagraphed API, with its method and path.\n` +
    `---\n\n` +
    `${operations.length} endpoint${operations.length === 1 ? "" : "s"}.\n\n` +
    `${rows}\n`
  );
}

async function main() {
  // path.resolve (CWD-relative) -- this script always runs as
  // `node scripts/generate-openapi-docs.ts` from apps/ui/.
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

  // #11204: what each tag's index page lists. Collected AFTER
  // splitOperationSummaries, so `summary` is the short humanized title and
  // `description` is the original prose — the same pair the operation page
  // itself renders.
  const operationsByTag = new Map();
  const metaByOperationId = new Map();
  for (const [route, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods ?? {})) {
      if (!op || typeof op !== "object" || !op.operationId) continue;
      const tag = primaryTag(op.tags);
      if (!operationsByTag.has(tag)) operationsByTag.set(tag, []);
      metaByOperationId.set(op.operationId, metaDescription(op, method, route));
      operationsByTag.get(tag).push({
        slug: kebabCase(op.operationId),
        title: op.summary ?? humanizeOperationId(op.operationId),
        method: method.toUpperCase(),
        route,
        description: firstSentence(op.description ?? ""),
      });
    }
  }

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
    await writeFile(
      to,
      withMetaDescription(await readFile(from, "utf8"), metaByOperationId.get(operationId)),
    );
    await rm(from);

    if (!pagesByTag.has(tag)) pagesByTag.set(tag, []);
    pagesByTag.get(tag).push(slug);
  }

  for (const [tag, pages] of pagesByTag) {
    // #11204: the group's own page. Without it `/docs/api-reference/<tag>` —
    // which every page in the group links, and which the site-wide breadcrumb
    // names as a crumb target — is a 404.
    const operations = (operationsByTag.get(tag) ?? []).filter((op) => pages.includes(op.slug));
    await writeFile(path.join(OUTPUT_DIR, tag, "index.mdx"), tagIndexPage(tag, operations));
    await writeFile(
      path.join(OUTPUT_DIR, tag, "meta.json"),
      // "index" first so the group page heads its own section in the nav,
      // matching how the reference root orders its own index.
      JSON.stringify({ title: tagTitle(tag), pages: ["index", ...pages.sort()] }, null, 2) + "\n",
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
