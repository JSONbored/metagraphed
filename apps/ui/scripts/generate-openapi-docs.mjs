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
import { readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { generateFiles } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";

const OUTPUT_DIR = process.env.OPENAPI_DOCS_OUTPUT ?? "./content/docs/api-reference";
// Read locally (fast, no network dependency for a rarely-changing generator
// script) but generate against the same unwrapped live URL the browser will
// fetch at request time.
const LOCAL_SPEC_PATH = "../../public/metagraph/openapi.json";
const LIVE_SPEC_URL = "https://api.metagraph.sh/metagraph/openapi.json";

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

  // index.mdx is hand-authored (a landing page, not generated), but lives
  // inside OUTPUT_DIR alongside the generated tree -- preserve it across
  // the rm -rf below rather than requiring every regeneration to remember
  // to restore it by hand.
  const indexPath = path.join(OUTPUT_DIR, "index.mdx");
  const indexContent = await readFile(indexPath, "utf8").catch(() => null);

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  if (indexContent !== null) await writeFile(indexPath, indexContent);

  const openapi = createOpenAPI({ input: [LIVE_SPEC_URL] });
  await generateFiles({
    input: openapi,
    output: OUTPUT_DIR,
    per: "operation",
    meta: false,
  });

  const entries = await readdir(OUTPUT_DIR);
  const pagesByTag = new Map();

  for (const entry of entries) {
    if (!entry.endsWith(".mdx") || entry === "index.mdx") continue;
    const operationId = entry.slice(0, -".mdx".length);
    const tag = tagByOperationId.get(operationId) ?? "misc";

    const tagDir = path.join(OUTPUT_DIR, tag);
    await mkdir(tagDir, { recursive: true });

    const from = path.join(OUTPUT_DIR, entry);
    const to = path.join(tagDir, entry);
    await rm(to, { force: true });
    await writeFile(to, await readFile(from, "utf8"));
    await rm(from);

    if (!pagesByTag.has(tag)) pagesByTag.set(tag, []);
    pagesByTag.get(tag).push(operationId);
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
