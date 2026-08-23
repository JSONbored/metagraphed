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
  // The SERVING tree (#10987). This gate watched only the schema tree, while
  // the copies people actually make live in src/ and workers/ -- contracts.ts
  // restating a query enum it could import, an MCP composer restating a route
  // vocabulary in its own literal. A vocabulary owned once in schemas-src and
  // restated four times in src/ was green here for as long as the gate has
  // existed, which is how the consolidation epics closed while the drift kept
  // appearing: the duplication moved to the one tree this never read.
  "src",
  "src/graphql",
  "workers",
  "workers/request-handlers",
  // And the producers (#10996): a script consuming a vocabulary operationally
  // must import the owner. Validator assertion-pins are declaration-invisible
  // here by design -- see the allowlist note below.
  "scripts",
  // And the UI (#10994): a chart restating a route's window enum is how a
  // selector offers a window its route rejects. The repointed sites read
  // QUERY_PARAMETER_ENUMS from the client package; what stays literal is
  // pinned below with its reason (a UI-domain vocabulary, a multi-route
  // control, an unpublished parameter).
  "apps/ui/src/components/metagraphed",
  "apps/ui/src/lib/metagraphed",
  "apps/ui/src/hooks",
  "apps/ui/src/routes",
];

/** Vocabularies allowed to coincide, pinned to the EXACT files that do.
 *
 * Keyed by the sorted value set, valued by the file list -- because a bare
 * value-set key hides what it names (#10987): with "all|in|out" allowlisted as
 * a string, a NEW copy of that list in any file was invisible, which meant the
 * one mechanism this gate has could be defeated by duplicating a vocabulary
 * that happened to coincide somewhere else once. A new file joining an entry
 * now fails the gate and forces the decision it should force; a file leaving
 * one makes the entry stale, and stale entries fail too. The list may only
 * shrink. */
const COINCIDENT_BY_DOMAIN: Record<string, string[]> = {
  // WINDOW SETS. Each route chooses the windows it serves, and schemas-src
  // declares six DIFFERENT sets -- 30d|7d, 30d|7d|90d, 1y|30d|7d|90d|all,
  // 24h|30d|7d|90d, 1h|24h|30d|7d, 1d|1h. Six sets is the proof each route
  // chose: coupling them would let one domain's change silently alter every
  // other. Each route owns its own tuple and its MCP tool imports THAT --
  // what is left is routes happening to offer the same windows.
  "1y|30d|7d|90d|all": [
    "schemas-src/routes/economics-trends.ts",
    "schemas-src/routes/subnet-history.ts",
    "schemas-src/routes/subnet-turnover.ts",
  ],
  "30d|7d|90d": [
    // The UI's two deliberate literals, each with its reason in-file.
    //
    // url-state.ts is the OWNER, not a coincidence: #11612 replaced the two
    // route-level copies of this set (the subnet dossier and the subnets hub)
    // with one exported `TRAILING_WINDOWS` that both import, which is exactly
    // what this gate asks for. It is pinned here because the gate cannot tell
    // an owner apart from a stray by shape -- the entry replaces
    // `subnet-window-helpers.ts`, which held this set until #11612 deleted
    // it, so the list does not grow.
    //
    // Note for anyone editing this comment: the scanner reads raw source, so
    // writing the set out as an array literal here -- even inside a comment --
    // makes THIS file a declaration site and fails the gate.
    //
    // The APY basis kept its own literal deliberately (#10994) until #11617
    // rebuilt that page from blank -- its window control imports the owner
    // like every other route's now, so this list is down to the owner alone.
    "apps/ui/src/lib/metagraphed/url-state.ts",
    "schemas-src/routes/account-activity-registrations.ts",
    "schemas-src/routes/account-activity.ts",
    "schemas-src/routes/chain-turnover.ts",
    "schemas-src/routes/subnet-concentration.ts",
    "schemas-src/routes/subnet-event-summary.ts",
    "schemas-src/routes/subnet-movers.ts",
    "schemas-src/routes/subnet-performance.ts",
    "schemas-src/routes/subnet-stake-flow.ts",
    "schemas-src/routes/subnet-yield.ts",
    "schemas-src/routes/validator-nominators.ts",
  ],
  // Per-domain lifecycle/verdict sets that coincide in value only.
  "active|deprecated|parked|pending": [
    "schemas-src/routes/curation-gaps.ts",
    "schemas-src/routes/subnet-detail.ts",
    "schemas-src/routes/subnets.ts",
  ],
  "dual|git|r2": [
    "schemas-src/artifacts/r2-manifest.ts",
    "schemas-src/routes/meta-contracts.ts",
  ],
  "missing-probe|not-monitored|probe-derived": [
    "schemas-src/routes/endpoints-pools.ts",
    "schemas-src/routes/providers-rpc.ts",
  ],
  // EVM precompile ABI argument names (src/evm-precompiles.ts) vs the Neon
  // nominator_positions primary-key column list -- the same three words
  // naming two unrelated things. A shared owner would couple an on-chain ABI
  // to a database index.
  // Inline `[...].includes(...)` assertions in scripts/validate*.ts are PINS:
  // literal on purpose, and invisible here because this gate matches
  // declaration forms only -- the right blindness, since deriving a
  // validator's expectation from the module it validates could never fail
  // (#10996).
  "bearish|bullish|neutral": [
    "schemas-src/routes/chain-alpha-volume.ts",
    "schemas-src/routes/subnet-alpha-volume.ts",
  ],
  "coldkey|hotkey|netuid": [
    "src/evm-precompiles.ts",
    "src/nominator-positions-neon-write.ts",
  ],
};

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
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
    // Assertion pins live in tests; the gate polices source only.
    if (name.includes(".test.")) continue;
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
      // An array of OBJECT literals (select options, column configs) is not a
      // value list -- the property-form regex can capture into one.
      if (raw.includes("{")) return;
      const values = [...raw.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      // Two members is a boolean in disguise (asc/desc, in/out) and carries no
      // vocabulary worth owning; three is where a real domain list starts.
      if (values.length < 3) return;
      if (values.every((value) => JSON_SCHEMA_TYPES.has(value))) return;
      // Namespaced platform names (og:title, twitter:card) are standards
      // vocabulary, not ours -- no owner could exist.
      if (values.some((value) => value.includes(":"))) return;
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
      // The optional type annotation matters: `const X: readonly string[] =`
      // broke the unannotated form and made DECODER_TABLES invisible -- a
      // vocabulary could hide from this gate by stating its own type (#11045
      // records the pair that did). `as const` is optional for the same
      // reason: an annotated tuple does not need it.
      /(?:export )?const \w+(?:\s*:[^=]+)?\s*=\s*\[([^\]]*)\]\s*(?:as const)?;/g,
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
    for (const match of source.matchAll(/\b(\w+):\s*\[([^\]]*)\][,;]/g)) {
      // `stdio: ["pipe", "pipe", "ignore"]` is Node's spawn wiring, not a
      // domain vocabulary -- five scripts legitimately configure it and no
      // owner could exist (#10996).
      if (match[1] === "stdio") continue;
      push(match[2]);
    }
  }
}

const byVocabulary = new Map<string, Set<string>>();
for (const site of sites) {
  const key = [...site.values].sort().join("|");
  if (!byVocabulary.has(key)) byVocabulary.set(key, new Set());
  byVocabulary.get(key)!.add(site.file);
}

const duplicated = [...byVocabulary.entries()].filter(
  ([, files]) => files.size > 1,
);

// An entry excuses exactly the files it names: a NEW file joining an
// allowlisted coincidence is a violation, reported with the files that are
// not covered rather than silently absorbed.
const unlisted = duplicated
  .map(([key, files]) => {
    const pinned = COINCIDENT_BY_DOMAIN[key];
    if (!pinned) return [key, files] as const;
    const strays = new Set([...files].filter((f) => !pinned.includes(f)));
    return [key, strays] as const;
  })
  .filter(([, files]) => files.size > 0)
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

// Stale in either dimension: the vocabulary no longer coincides at all, or a
// pinned FILE no longer declares it. Both mean the entry over-excuses.
const stale = Object.entries(COINCIDENT_BY_DOMAIN)
  .flatMap(([key, pinned]) => {
    const files = byVocabulary.get(key);
    if (!files || files.size <= 1)
      return [`    [${key.split("|").join(", ")}] — no longer duplicated`];
    return pinned
      .filter((f) => !files.has(f))
      .map(
        (f) =>
          `    [${key.split("|").join(", ")}] — ${f} no longer declares it`,
      );
  })
  .sort();
if (stale.length > 0) {
  errors.push(
    `${stale.length} allowlist entr(y/ies) over-excuse — shrink them (the coincidence resolved itself):\n` +
      stale.join("\n"),
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
// A module namespace assigns to `Record<string, unknown>` on its own -- what
// it does NOT do is assign to `Record<string, readonly string[]>`, which is
// what the old assertion claimed about every export in both modules. That
// claim is also the thing this script exists to doubt: it reads these to find
// out whether an export is still a vocabulary, having asserted that it is.
const collections: Record<string, unknown> = API_QUERY_COLLECTIONS;
const mirrors: Record<string, unknown> = mcpShared;

/**
 * A vocabulary, checked rather than assumed.
 *
 * `Array.isArray` alone was the whole check, and it leaves the elements `any`:
 * an enum that had picked up a number, or a nested array, would be sorted and
 * joined into the comparison string without complaint, and the drift report
 * would print it as though it were a name. Both sides of every comparison
 * below now come through here, so a malformed vocabulary is reported as
 * malformed instead of being compared.
 */
function stringVocabulary(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

/** `sort_fields` off one API_QUERY_COLLECTIONS entry, or null if the entry or
 *  the field is gone. */
function sortFieldsOf(collection: unknown): readonly string[] | null {
  if (typeof collection !== "object" || collection === null) return null;
  return stringVocabulary((collection as Record<string, unknown>).sort_fields);
}

for (const [name, collection] of Object.entries(MIRRORED_VOCABULARIES)) {
  const mirrored = stringVocabulary(mirrors[name]);
  if (mirrored === null) {
    errors.push(
      `${name} is declared as a mirror of API_QUERY_COLLECTIONS["${collection}"].sort_fields ` +
        `but schemas-src/mcp-tools/shared.ts no longer exports it — delete the entry above, ` +
        `or restore the export.`,
    );
    continue;
  }
  const source = sortFieldsOf(collections[collection]);
  if (source === null) {
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

/**
 * Every mirror module, imported by LITERAL specifier.
 *
 * `await import(module)` with a variable reads better and is invisible to
 * static analysis: knip resolves a literal specifier and nothing else, so the
 * moment this stopped being one, `schemas-src/shared.ts` went from "reached
 * from an entry" to 18 unreferenced type exports and
 * validate:unreferenced-exports counted 898 against its 880 ceiling (#10292).
 * The table above stays the declaration; this is only how it is loaded.
 */
const MIRROR_MODULE_LOADERS: Record<
  string,
  () => Promise<Record<string, unknown>>
> = {
  "../schemas-src/shared.ts": () => import("../schemas-src/shared.ts"),
  "../schemas-src/routes/subnet-detail.ts": () =>
    import("../schemas-src/routes/subnet-detail.ts"),
};

const mirrorModules = new Map<string, Record<string, unknown>>();
for (const { module } of JSON_SCHEMA_MIRRORS) {
  if (mirrorModules.has(module)) continue;
  const load = MIRROR_MODULE_LOADERS[module];
  if (!load) {
    // A new mirror whose module was added to the table but not here would
    // otherwise throw a bare TypeError at the call below.
    throw new Error(
      `${module} is named by JSON_SCHEMA_MIRRORS but has no entry in ` +
        `MIRROR_MODULE_LOADERS -- add one, with a literal import specifier.`,
    );
  }
  mirrorModules.set(module, await load());
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
  const zodValues = stringVocabulary(schemaSrcShared[zodExport]);
  const schemaValues = stringVocabulary(node);
  if (schemaValues === null) {
    errors.push(
      `${schemaFile} has no list-of-strings enum at ${pointer.join(".")} — ` +
        `it is either gone (update JSON_SCHEMA_MIRRORS, or restore it) or it ` +
        `has picked up a non-string entry, which is not a vocabulary and ` +
        `cannot be compared against one.`,
    );
    continue;
  }
  if (zodValues === null) {
    errors.push(
      `${zodExport} is not a list of strings, but it mirrors ` +
        `${schemaFile}#${pointer.join(".")} — it is either no longer exported ` +
        `from ${module}, or no longer a vocabulary.`,
    );
    continue;
  }
  const fromSchema = [...schemaValues].sort().join(",");
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
    `${duplicated.length} still restated in more than one file (all per-domain coincidences pinned to their exact files — see COINCIDENT_BY_DOMAIN); ` +
    `${Object.keys(MIRRORED_VOCABULARIES).length} cross-boundary mirrors match the collection that owns them; ` +
    `${JSON_SCHEMA_MIRRORS.length} JSON Schema enum(s) match their schemas-src copy.`,
);
