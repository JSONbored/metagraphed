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
const NOT_YET_OWNED: string[] = [
  "1y|30d|7d|90d|all",
  "30d|7d|90d",
  "active|deprecated|parked|pending",
  "adapter-backed|directory-only|identity-complete|identity-partial|operational",
  "adapter_score|candidate_count|completeness_score|curation_level|endpoint_count|evidence_action|identity_level|identity_surface_count|lane|name|netuid|operational_interface_count|priority_score|profile_level|review_state|stale_candidate_count|surface_count|verified_candidate_count",
  "agent-ready|candidate-review|hard-blocked|machine-usable|missing-interface|needs-evidence",
  "all|in|out",
  "archive|subtensor-rpc|subtensor-wss",
  "auth-required|content-mismatch|dead|live|rate-limited|redirected|timeout|transient|unsafe|unsupported|wrong-chain",
  "auto_review_candidate|evidence_action|identity_level|kind|lane|manual_review_required|name|netuid|priority_score|profile_level|submission_route|target_action|target_type",
  "avg_validator_trust|max_validator_trust|stake_dominance|subnet_count|total_emission|total_stake|uid_count",
  "base-layer|blocked|callable|candidate|needs-evidence",
  "bearish|bullish|neutral",
  "biggest-alpha-gain-1d|biggest-alpha-gain-7d|cheapest-registration|highest-emission|open-slots|validator-headroom",
  "candidate_api_count|candidate_api_kinds|curation_level|name|netuid|operational_kinds|operational_surface_count|priority_score|recommended_adapter_kind",
  "candidate_count|completeness_score|identity_level|identity_promotion_kind_count|identity_surface_count|live_identity_candidate_kind_count|missing_critical_count|name|native_identity_signal_count|native_name_quality|netuid|priority_score|profile_level|stale_identity_candidate_kind_count",
  "candidate_count|curation_level|missing_kinds|name|netuid|priority_score|surface_count|verified_candidate_count",
  "chain|empty|placeholder",
  "claim|source_url|subject|verified_at",
  "classification|kind|last_checked|last_ok|latency_ms|netuid|provider|status|status_code|surface_id|verified_at",
  "complete|directory|none|partial",
  "confidence|id|kind|name|netuid|provider|state",
  "coverage_level|curation_level|gap_count|name|netuid",
  "coverage_level|curation_level|name|netuid",
  "critical|info|warning",
  "custom-adapter|data-artifact-adapter|generic-openapi-or-custom|stream-adapter",
  "delegated_tao|free_tao|net_flow_30d|net_flow_7d|net_flow_90d|total_tao",
  "dual|git|r2",
  "eligible_count|endpoint_count|id|kind",
  "emission|entity_emission|entity_stake|stake|validator_stake",
  "emission|neurons|stake|validators",
  "evidence_action|lane|name|netuid|priority_score",
  "gini|holders|nakamoto_coefficient|netuid|top_1pct_share|total",
  "gross_staked|last_activity|net_staked",
  "hard-blocked|missing-data|needs-review|none",
  "hard|missing-data|needs-review",
  "high|low|medium",
  "id|kind|name|netuid|provider",
  "kind|last_checked|latency_ms|layer|netuid|pool_eligible|provider|publication_state|score|status",
  "last_active|stake_dominance|subnet_count|total_emission|total_stake|uid_count|validator_count",
  "missing-probe|not-monitored|probe-derived",
  "provider|subnet|surface",
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

const allowed = new Set(NOT_YET_OWNED);
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
    `${stale.length} allowlist entr(y/ies) no longer name a duplicated vocabulary — delete them:\n` +
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
    `${duplicated.length} still restated in more than one file (all declared debt against #9799).`,
);
