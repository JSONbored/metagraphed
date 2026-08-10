// A vocabulary must have ONE owner (#9799).
//
// 56 distinct enum vocabularies appeared in more than one file under
// schemas-src/, 201 occurrences in total -- and several of them already had a
// canonical Zod export that the copies simply never imported. That is the same
// disease as the response shapes (#9796): a value set with a real owner,
// restated by hand somewhere else, with nothing detecting the divergence.
//
// The cost is not theoretical. Adding a trailing window or a surface kind means
// editing up to twenty files, and any one that is missed silently under-declares
// -- a caller passing a legitimate value gets rejected by a schema written
// before that value existed.
//
// This gate fails when a string-literal list of three or more members appears in
// more than one schema file and is not on the allowlist below. Each allowlist
// entry is a standing admission, not a decision: the entries name vocabularies
// whose owner has not been extracted yet, and the list may only shrink. Same
// mechanism, and the same reading, as validate-schema-opacity.ts's
// NOT_YET_TYPED.
import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";

const SCHEMA_DIRS = [
  "schemas-src",
  "schemas-src/routes",
  "schemas-src/mcp-tools",
  "schemas-src/artifacts",
];

/** Vocabularies still restated in more than one file. Each is a value set whose
 * owner has not been extracted yet -- delete the entry when it is, never add
 * one to silence a NEW copy. Keyed by the sorted value set, so a copy that
 * merely reorders the list is the same entry. */
const COINCIDENT_BY_DOMAIN: string[] = [
  // WINDOW SETS. Each route chooses the windows it serves, and schemas-src
  // declares six DIFFERENT sets -- 30d|7d, 30d|7d|90d, 1y|30d|7d|90d|all,
  // 24h|30d|7d|90d, 1h|24h|30d|7d, 1d|1h. Six sets is the proof each route
  // chose: coupling them would let one domain's change silently alter every
  // other. Each route now owns its own tuple and its MCP tool imports THAT --
  // what is left below is two routes happening to offer the same three.
  "1y|30d|7d|90d|all",
  "30d|7d|90d",
  // Per-domain lifecycle/verdict sets that coincide in value only.
  "active|deprecated|parked|pending",
  "all|in|out",
  "base-layer|blocked|callable|candidate|needs-evidence",
  "bearish|bullish|neutral",
  "dual|git|r2",
  "hard-blocked|missing-data|needs-review|none",
  "missing-probe|not-monitored|probe-derived",
];

const errors: string[] = [];

type Site = { file: string; values: string[] };
const sites: Site[] = [];
for (const dir of SCHEMA_DIRS) {
  const absolute = path.join(repoRoot, dir);
  let entries: string[];
  try {
    entries = await fs.readdir(absolute);
  } catch {
    continue;
  }
  for (const name of entries) {
    if (!name.endsWith(".ts")) continue;
    const file = `${dir}/${name}`;
    const source = await fs.readFile(path.join(absolute, name), "utf8");
    // JSON Schema's own type names. A `type: ["array","string","null"]` union
    // is not a domain vocabulary with an owner, and the object-property form
    // below cannot tell it apart from one by shape alone.
    const JSON_SCHEMA_TYPES = new Set([
      "array",
      "boolean",
      "integer",
      "null",
      "number",
      "object",
      "string",
    ]);
    const push = (raw: string) => {
      const values = [...raw.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      // Two members is a boolean in disguise (asc/desc, in/out) and carries no
      // vocabulary worth owning; three is where a real domain list starts.
      if (values.length < 3) return;
      if (values.every((value) => JSON_SCHEMA_TYPES.has(value))) return;
      sites.push({ file, values });
    };
    // `z\s*\.enum`, not `z\.enum`: prettier breaks a chain across lines once it
    // grows past the print width, so `z.enum([...])` becomes `z` then
    // `.enum([...])` on the next line the moment a `.describe()` is added. The
    // anchored form stopped matching `chain-alpha-volume.ts` for exactly that
    // reason and the gate reported the bullish/bearish/neutral allowlist entry
    // as STALE -- a formatting change had made it blind, and the fix it asked
    // for was to delete the entry guarding a live duplicate (#10288).
    for (const match of source.matchAll(/z\s*\.enum\(\s*\[([^\]]*)\]\s*\)/g))
      push(match[1]);
    for (const match of source.matchAll(
      /(?:export )?const \w+\s*=\s*\[([^\]]*)\]\s*as const;/g,
    ))
      push(match[1]);
    // A vocabulary declared as an OBJECT PROPERTY (#10060). This gate matched
    // only the two top-level forms above, and `schemas-src/query-enums.ts` --
    // the file whose entire job is holding vocabularies -- writes every one of
    // them as `name: [ … ],` inside `QUERY_ENUMS`. So the one place a duplicate
    // was most likely to be was the one place the gate could not see, and
    // `surfaceKind` sat there restating `SURFACE_KIND_VALUES` in a different
    // order: the routes published one and the MCP tools the other, which is 32
    // of the tool-vs-route enum divergences #10060 was counting.
    for (const match of source.matchAll(/\b\w+:\s*\[([^\]]*)\][,;]/g))
      push(match[1]);
  }
}

const byVocabulary = new Map<string, Set<string>>();
for (const site of sites) {
  const key = [...site.values].sort().join("|");
  if (!byVocabulary.has(key)) byVocabulary.set(key, new Set());
  byVocabulary.get(key)!.add(site.file);
}

const allowed = new Set(COINCIDENT_BY_DOMAIN);
const duplicated = [...byVocabulary.entries()].filter(
  ([, files]) => files.size > 1,
);

const unlisted = duplicated
  .filter(([key]) => !allowed.has(key))
  .sort((a, b) => b[1].size - a[1].size);
if (unlisted.length > 0) {
  errors.push(
    `${unlisted.length} vocabular(y/ies) restated in more than one schema file with no single owner:\n` +
      unlisted
        .map(
          ([key, files]) =>
            `    [${key.split("|").slice(0, 6).join(", ")}${key.split("|").length > 6 ? ", …" : ""}]\n` +
            [...files]
              .sort()
              .map((file) => `      ${file}`)
              .join("\n"),
        )
        .join("\n") +
      `\n  Export the value set ONCE from the module that owns it and import it at each site. ` +
      `Where the owner is a Record, derive the tuple from its keys so the two cannot disagree.`,
  );
}

const stale = [...allowed]
  .filter((key) => !byVocabulary.get(key) || byVocabulary.get(key)!.size <= 1)
  .sort();
if (stale.length > 0) {
  errors.push(
    `${stale.length} allowlist entr(y/ies) no longer name a duplicated vocabulary — delete them (the coincidence resolved itself):\n` +
      stale.map((key) => `    [${key.split("|").join(", ")}]`).join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Cross-boundary mirrors (#10005).
//
// schemas-src/ imports from neither src/ nor workers/ -- a rule the code states
// itself ("a literal here because schemas-src/ imports from neither"). So a
// vocabulary owned by API_QUERY_COLLECTIONS in src/contracts.ts CANNOT be
// imported by the schema layer, and mirroring it is the correct answer to that
// constraint. What was missing is the other half: nothing asserted the mirror
// still matched.
//
// The cost of a silent divergence is asymmetric and neither half is loud. A
// sort value added to the collection but not the mirror means the route accepts
// an order the tool rejects -- an agent told a valid value is invalid. A value
// REMOVED is worse: the tool keeps advertising a sort the route now ignores, so
// the caller gets an unsorted answer that looks sorted. Same silent-wrong-data
// class as the list_gaps `sort` no-op.
//
// Declared by name rather than matched by shape: two collections can share a
// sort_fields set by coincidence (endpoint-pools/rpc-pools/pools do), and
// "some collection somewhere agrees with this tuple" is not the property worth
// asserting.
const MIRRORED_VOCABULARIES: Record<string, string> = {
  CANDIDATE_SORT_VALUES: "candidates",
  COVERAGE_DEPTH_SORT_VALUES: "coverage-depth",
  ENDPOINT_POOL_SORT_VALUES: "endpoint-pools",
  ENDPOINT_SORT_VALUES: "endpoints",
  EVIDENCE_ENTRY_SORT_VALUES: "claims",
  HEALTH_SURFACE_SORT_VALUES: "health-surfaces",
  SURFACE_SORT_VALUES: "curated-surfaces",
};

const [{ API_QUERY_COLLECTIONS }, mcpShared] = await Promise.all([
  import("../src/contracts.ts"),
  import("../schemas-src/mcp-tools/shared.ts"),
]);
const collections = API_QUERY_COLLECTIONS as Record<
  string,
  { sort_fields?: readonly string[] }
>;
const mirrors = mcpShared as unknown as Record<string, readonly string[]>;

for (const [name, collection] of Object.entries(MIRRORED_VOCABULARIES)) {
  const mirrored = mirrors[name];
  if (!Array.isArray(mirrored)) {
    errors.push(
      `${name} is declared as a mirror of API_QUERY_COLLECTIONS["${collection}"].sort_fields ` +
        `but schemas-src/mcp-tools/shared.ts no longer exports it — delete the entry above, ` +
        `or restore the export.`,
    );
    continue;
  }
  const source = collections[collection]?.sort_fields;
  if (!Array.isArray(source)) {
    errors.push(
      `${name} mirrors API_QUERY_COLLECTIONS["${collection}"], which no longer declares sort_fields.`,
    );
    continue;
  }
  const a = [...mirrored].sort().join(",");
  const b = [...source].sort().join(",");
  if (a !== b) {
    errors.push(
      `${name} has drifted from API_QUERY_COLLECTIONS["${collection}"].sort_fields:\n` +
        `    schemas-src: ${a || "(empty)"}\n` +
        `    contracts:   ${b || "(empty)"}\n` +
        `  The collection OWNS this vocabulary. Update the mirror, never the source, ` +
        `unless the route's sort set genuinely changed.`,
    );
  }
}

// The JSON Schema half (#10483).
//
// The mirrors above are Zod-to-Zod. This one crosses a bigger boundary: a
// registry document is validated against schemas/*.schema.json, while the API
// that serves it is typed from schemas-src/. When those two disagree about a
// value set, the registry accepts a document the contract cannot describe --
// and it fails in the one direction nothing tests, because the invalid value
// does not exist until somebody writes the first entry using it.
//
// That is exactly what happened here. #10442/#10516 added `payment-collector`,
// `treasury`, `burn` and `multisig` to entity.schema.json's category enum and
// not to ENTITY_CATEGORY_VALUES. `registry/entities/` is empty, so no document
// carried one, so every gate passed for as long as the layer stayed unused.
//
// THE JSON SCHEMA OWNS THE VOCABULARY. It is what a contribution is validated
// against, so the Zod enum is the copy and the fix is always to widen the copy.
const JSON_SCHEMA_MIRRORS: Array<{
  schemaFile: string;
  pointer: string[];
  module: string;
  zodExport: string;
}> = [
  {
    schemaFile: "schemas/entity.schema.json",
    pointer: ["properties", "category", "enum"],
    module: "../schemas-src/shared.ts",
    zodExport: "ENTITY_CATEGORY_VALUES",
  },
  // #10586, declared alongside the vocabulary rather than after it drifted.
  // The entity-category pair above was added the other way round.
  {
    schemaFile: "schemas/subnet-manifest.schema.json",
    pointer: ["$defs", "wallet_search", "properties", "outcome", "enum"],
    module: "../schemas-src/routes/subnet-detail.ts",
    zodExport: "WALLET_SEARCH_OUTCOME_VALUES",
  },
  {
    schemaFile: "schemas/subnet-manifest.schema.json",
    pointer: [
      "$defs",
      "wallet_search",
      "properties",
      "checked",
      "items",
      "enum",
    ],
    module: "../schemas-src/routes/subnet-detail.ts",
    zodExport: "WALLET_SEARCH_CHECKED_VALUES",
  },
];

const mirrorModules = new Map<string, Record<string, readonly string[]>>();
for (const { module } of JSON_SCHEMA_MIRRORS) {
  if (mirrorModules.has(module)) continue;
  mirrorModules.set(
    module,
    (await import(module)) as unknown as Record<string, readonly string[]>,
  );
}

for (const { schemaFile, pointer, module, zodExport } of JSON_SCHEMA_MIRRORS) {
  const schemaSrcShared = mirrorModules.get(module)!;
  const raw = JSON.parse(
    await fs.readFile(path.join(repoRoot, schemaFile), "utf8"),
  ) as unknown;
  let node: unknown = raw;
  for (const key of pointer) {
    node = (node as Record<string, unknown> | null)?.[key];
  }
  const zodValues = schemaSrcShared[zodExport];
  if (!Array.isArray(node)) {
    errors.push(
      `${schemaFile} no longer has an enum at ${pointer.join(".")} — ` +
        `update JSON_SCHEMA_MIRRORS, or restore the enum.`,
    );
    continue;
  }
  if (!Array.isArray(zodValues)) {
    errors.push(
      `schemas-src/shared.ts no longer exports ${zodExport}, which mirrors ` +
        `${schemaFile}#${pointer.join(".")}.`,
    );
    continue;
  }
  const fromSchema = [...(node as string[])].sort().join(",");
  const fromZod = [...zodValues].sort().join(",");
  if (fromSchema !== fromZod) {
    errors.push(
      `${zodExport} has drifted from ${schemaFile}#${pointer.join(".")}:\n` +
        `    schemas-src: ${fromZod || "(empty)"}\n` +
        `    JSON Schema: ${fromSchema || "(empty)"}\n` +
        `  The JSON Schema OWNS this vocabulary — it is what a registry ` +
        `contribution is validated against. Widen the Zod copy, not the source.`,
    );
  }
}

if (errors.length > 0) {
  console.error(
    `Schema-vocabulary validation failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Schema-vocabulary validation passed: ${byVocabulary.size} distinct vocabularies, ` +
    `${duplicated.length} still restated in more than one file (all per-domain coincidences, not debt — see COINCIDENT_BY_DOMAIN); ` +
    `${Object.keys(MIRRORED_VOCABULARIES).length} cross-boundary mirrors match the collection that owns them; ` +
    `${JSON_SCHEMA_MIRRORS.length} JSON Schema enum(s) match their schemas-src copy.`,
);
