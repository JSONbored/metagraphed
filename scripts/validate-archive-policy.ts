// Every Neon table must say whether it belongs in the archive.
//
// THE GAP THIS CLOSES. Three gates already compare the two stores, and none of
// them asks the question that matters most for a long-term record:
//
//   db-types-drift          Neon        -> its generated types
//   lakehouse-types-drift   the catalog -> its generated types + Zod
//   store-type-parity       shared COLUMNS, both directions (#11060)
//   check-lakehouse-freshness   every lakehouse table is classified and fresh
//
// The freshness watchdog already reconciles the LAKEHOUSE side: all 26 `chain`
// tables carry a declared cadence and an unclassified one fails. Nothing
// reconciles the NEON side. Neon holds 64 tables, the lakehouse holds 26, and
// 18 are shared -- so 46 Neon tables have no copy in the archive and, until
// now, no recorded reason. "It is not there" and "it is not meant to be there"
// were indistinguishable.
//
// That is how `subnet_burn_history`, `subnet_lifecycle` and nine other
// chain-derived tables ended up with no archive copy and nobody noticing: each
// one is individually plausible as an oversight or as a decision, and there was
// no place where the difference was written down.
//
// A table absent from POLICY fails. A new Neon table cannot enter without
// someone stating what happens to it -- the same rule, and for the same reason,
// as the watchdog's EXPECTED.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import {
  validateArchiveBundles,
  type ArchiveBundleContract,
  type ArchiveBundleMapping,
  type BundleSourceColumn,
  type BundleCatalogColumn,
} from "./archive-policy-bundles.ts";

/**
 * What the archive does with each Neon table.
 *
 * `mirrored`  copied to the lakehouse by metagraphed-infra's state mirror or
 *             its daily rollups. These are the 18 shared tables.
 *
 * `pending`   chain-derived and SHOULD be archived, but has no producer yet.
 *             This is a debt list, not a verdict: every entry is a table whose
 *             history is being kept only in the serving tier, where nothing
 *             promises to keep it. Tracked in metagraphed-infra#510.
 *
 * `bundled`   immutable row families preserved together in a verified complete
 *             capture bundle, with a separately declared catalog index. Requires
 *             an explicit whole-group mapping; not a same-name table mirror.
 *
 * `serving`   operational state that describes the SYSTEM rather than the
 *             chain: probe results, lane health, capture cursors, usage
 *             rollups. Rebuilt continuously and meaningless once stale, so an
 *             archive copy would be storage without a reader.
 *
 * `sensitive` must NOT be archived. API keys, account identities, push
 *             subscriptions and alert targets are credentials or personal
 *             data; copying them into an append-only store with no delete path
 *             is the opposite of what they need.
 *
 * `transient` per-pass bookkeeping (`*_passes`), which records that a capture
 *             attempt happened. The rows it guards are archived; the attempt
 *             log is not.
 *
 * `meta`      schema bookkeeping.
 */
export type Policy =
  | "mirrored"
  | "pending"
  | "bundled"
  | "serving"
  | "sensitive"
  | "transient"
  | "meta";

// Support only (#12086). Actual mappings require credentialed catalog metadata
// and deployed publication/read-back evidence. This pure metadata gate cannot
// establish those runtime facts, and an authored declaration is not that proof.
// Keep unprovisioned examples in tests; do not classify history to bypass debt.
export const BUNDLE_CONTRACTS: Readonly<Record<string, ArchiveBundleContract>> =
  {};
export const BUNDLE_MAPPINGS: readonly ArchiveBundleMapping[] = [];

export const POLICY: Readonly<Record<string, Policy>> = {
  // -- mirrored: the 18 tables the archive already holds -------------------
  account_balances: "mirrored",
  account_identity: "mirrored",
  account_identity_history: "mirrored",
  account_position_daily: "mirrored",
  neuron_daily: "mirrored",
  neurons: "mirrored",
  nominator_positions: "mirrored",
  providers: "mirrored",
  self_health_daily: "mirrored",
  subnet_hyperparams: "mirrored",
  subnet_hyperparams_history: "mirrored",
  subnet_identity_history: "mirrored",
  subnet_ownership: "mirrored",
  subnet_ownership_history: "mirrored",
  subnet_snapshots: "mirrored",
  subnets: "mirrored",
  surfaces: "mirrored",
  validator_nominator_counts: "mirrored",

  // -- formerly the archive debt, now empty ---------------------------------
  //
  // `subnet_burn_history` was the last entry, and it closed on a MEASUREMENT
  // rather than more effort. It has no `id`, and `observed_at` alone ties
  // 94,208 times across 852 distinct values, so a `> since` watermark would
  // have skipped nearly every row. `(observed_at, netuid)` is unique -- 95,447
  // rows, 95,447 distinct pairs, zero ties -- and metagraphed-infra#553 taught
  // the mirror to compare row values in one predicate.
  //
  // PENDING_CEILING is 0 and only falls, so a table filed as `pending` from
  // here fails the gate outright. Deliberate: `pending` was a debt list being
  // paid down, and it must not become a parking space for anything nobody
  // wants to classify.
  //
  // NOT only chain data. The first cut of this map filed anything that was not
  // chain-derived under `serving`, which was too fast: `surface_uptime_daily`,
  // `surface_failure_daily`, `surface_history`, `revenue_observations` and
  // `compute_declarations` are TIME SERIES about the registry, and a time
  // series kept only in the serving tier is one nothing promises to keep. The
  // test is not "is it about the chain" but "does yesterday's value still mean
  // something" -- a probe cursor fails that, a year of uptime does not.
  // Each of these is a fact about the CHAIN, not about us, and the serving
  // tier is currently the only place it exists.
  //
  // `subnet_identity` is the sharpest example: the archive holds
  // `subnet_identity_history` but not the current-state table it is the
  // history OF, so the lakehouse can say what a subnet's identity USED to be
  // and not what it is.
  chain_concentration_daily: "mirrored",
  emission_flow_watch: "mirrored",
  emission_gate_param_history: "mirrored",
  hotkey_alpha: "mirrored",
  subnet_burn_history: "mirrored",
  subnet_deregistration_daily: "mirrored",
  subnet_emission_enabled_history: "mirrored",
  subnet_identity: "mirrored",
  subnet_lifecycle: "mirrored",
  tao_usd_index: "mirrored",
  treasury_readings: "mirrored",

  // -- serving: state, not history -----------------------------------------
  // These are overwritten in place or rebuilt continuously, so there is no
  // series to keep: a capture cursor, a circuit-breaker verdict, the current
  // head. Yesterday's value is not a fact about yesterday, it is a stale
  // reading of the same thing.
  //
  // `surface_checks` and `self_health_checks` are raw probe rows that
  // `surface_uptime_daily` and `self_health_daily` already summarise; the
  // rollups are archived, the raw firehose is not.
  api_key_usage_daily: "serving",
  api_quota_daily: "serving",
  api_usage_rollup: "serving",
  attribution_candidates: "serving",
  attribution_sweeps: "serving",
  blocks_head: "serving",
  chain_detail_account_events: "serving",
  chain_detail_blocks: "serving",
  chain_detail_chain_events: "serving",
  chain_detail_extrinsics: "serving",
  compute_declarations: "mirrored",
  lane_health: "serving",
  origin_reachability: "serving",
  raw_capture_state: "serving",
  revenue_observations: "mirrored",
  revenue_probe_failures: "serving",
  self_health_checks: "serving",
  surface_checks: "serving",
  surface_failure_daily: "mirrored",
  surface_history: "mirrored",
  surface_status: "serving",
  surface_uptime_daily: "mirrored",

  // -- sensitive: never archived -------------------------------------------
  api_key_blocks: "sensitive",
  api_keys: "sensitive",
  chain_alert_deliveries: "sensitive",
  chain_alert_triggers: "sensitive",
  github_accounts: "sensitive",
  rpc_accounts: "sensitive",
  watch_push_subscriptions: "sensitive",

  // -- transient / meta ----------------------------------------------------
  account_balances_passes: "transient",
  hotkey_alpha_passes: "transient",
  neurons_passes: "transient",
  nominator_positions_passes: "transient",
  // Bounded delivery evidence for the scan watchdog, retained for 30 days.
  nominator_scan_receipts: "transient",
  validator_nominator_counts_passes: "transient",
  schema_migrations: "meta",
};

/** How many `pending` tables we accept. ONLY FALLS. */
export const PENDING_CEILING = 0;

interface Column {
  table: string;
}

export function neonTables(snapshot: Column[]): string[] {
  return [...new Set(snapshot.map((c) => c.table))].sort();
}

export function compare(tables: string[]): {
  unclassified: string[];
  stale: string[];
  pending: string[];
} {
  const declared = new Set(Object.keys(POLICY));
  const present = new Set(tables);
  return {
    // A table Neon has and POLICY does not: someone added a table without
    // saying whether the archive wants it.
    unclassified: tables.filter((t) => !declared.has(t)),
    // A table POLICY has and Neon does not: the policy is describing something
    // that no longer exists, which makes every count it feeds wrong.
    stale: [...declared].filter((t) => !present.has(t)).sort(),
    pending: tables.filter((t) => POLICY[t] === "pending").sort(),
  };
}

function main(): void {
  const snapshot = JSON.parse(
    readFileSync(path.join(repoRoot, "generated/db/schema.json"), "utf8"),
  ) as BundleSourceColumn[];
  const tables = neonTables(snapshot);
  const { unclassified, stale, pending } = compare(tables);

  const problems = validateArchiveBundles({
    source: snapshot,
    catalog: JSON.parse(
      readFileSync(
        path.join(repoRoot, "generated/lakehouse/schema.json"),
        "utf8",
      ),
    ) as BundleCatalogColumn[],
    policies: POLICY,
    contracts: BUNDLE_CONTRACTS,
    mappings: BUNDLE_MAPPINGS,
  });
  if (unclassified.length) {
    problems.push(
      `${unclassified.length} Neon table(s) have no archive policy:\n  ` +
        unclassified.join("\n  ") +
        `\n  -> add each to POLICY in scripts/validate-archive-policy.ts.` +
        `\n     "mirrored" if the state mirror carries it, "pending" if it is` +
        `\n     chain history still owed an archive copy, "serving" if it` +
        `\n     describes the system rather than the chain, "sensitive" if it` +
        `\n     must never be archived. "bundled" requires a complete verified` +
        `\n     capture mapping, actual catalog metadata and deployed evidence.`,
    );
  }
  if (stale.length) {
    problems.push(
      `${stale.length} POLICY entr(ies) name a table Neon no longer has:\n  ` +
        stale.join("\n  ") +
        `\n  -> remove them; a policy describing a dropped table inflates the` +
        `\n     pending count and hides real debt.`,
    );
  }
  if (pending.length > PENDING_CEILING) {
    problems.push(
      `pending archive debt rose to ${pending.length}, ceiling is ${PENDING_CEILING}:\n  ` +
        pending.join("\n  "),
    );
  }

  if (problems.length) {
    process.stderr.write(`archive-policy:\n${problems.join("\n\n")}\n`);
    process.exit(1);
  }

  const counts = new Map<Policy, number>();
  for (const table of tables) {
    const policy = POLICY[table] as Policy;
    counts.set(policy, (counts.get(policy) ?? 0) + 1);
  }
  const summary = [...counts]
    .sort()
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  process.stdout.write(
    `archive-policy: ${tables.length} Neon table(s) classified — ${summary}.\n`,
  );
  if (pending.length) {
    process.stdout.write(
      `  ${pending.length} awaiting an archive producer (ceiling ${PENDING_CEILING}, only falls):\n    ` +
        pending.join("\n    ") +
        "\n",
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
