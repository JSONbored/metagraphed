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
    const push = (raw: string) => {
      const values = [...raw.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      // Two members is a boolean in disguise (asc/desc, in/out) and carries no
      // vocabulary worth owning; three is where a real domain list starts.
      if (values.length >= 3) sites.push({ file, values });
    };
    for (const match of source.matchAll(/z\.enum\(\s*\[([^\]]*)\]\s*\)/g))
      push(match[1]);
    for (const match of source.matchAll(
      /(?:export )?const \w+\s*=\s*\[([^\]]*)\]\s*as const;/g,
    ))
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

if (errors.length > 0) {
  console.error(
    `Schema-vocabulary validation failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Schema-vocabulary validation passed: ${byVocabulary.size} distinct vocabularies, ` +
    `${duplicated.length} still restated in more than one file (all per-domain coincidences, not debt — see COINCIDENT_BY_DOMAIN).`,
);
