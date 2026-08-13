// Did every lakehouse table receive a snapshot recently enough? (#11048)
//
// ## What this is for
//
// `src/table-freshness-watchdog.ts` watches every NEON table, and its own
// header records why: per-lane watchdogs cover only the lanes somebody
// remembered, so on 2026-08-07 four registry tables sat frozen for five days
// and nothing reported it.
//
// The lakehouse had no counterpart, and it cost the same way, larger: measured
// 2026-08-13, NINETEEN of the 26 tables in `chain` last received a snapshot on
// 2026-08-02 -- eleven days, unreported. The routes over them looked healthy
// the whole time, because the hot tier answers first and a frozen table
// returns rows perfectly happily. There is no decline to notice.
//
// ## Why the CATALOG and not the data
//
// Freshness here is "did anything arrive", which Iceberg already records: each
// table's metadata carries `snapshots[].timestamp-ms`, so the newest write is
// one metadata read per table. Asking the DATA the same question
// (`SELECT MAX(observed_at)`) is a full scan against a budget this repo has
// already been rate-limited on (#9465), for an answer the catalog hands over
// for free.
//
// ## Every table must be CLASSIFIED
//
// A table absent from `EXPECTED` fails, exactly as it does on the Neon side.
// Absent means nobody has thought about it; `maxAgeMs: null` with a reason
// means somebody decided it cannot go stale. The two are different facts and
// only one of them is safe.
import { fileURLToPath } from "node:url";

const BASE =
  process.env.R2_CATALOG_URI ??
  "https://catalog.cloudflarestorage.com/918f0f0e2eb26709d1cf4fb76085c8fb/metagraphed-lakehouse";
const WAREHOUSE =
  process.env.R2_WAREHOUSE ??
  "918f0f0e2eb26709d1cf4fb76085c8fb_metagraphed-lakehouse";
// The R2 SQL door takes the BARE bucket name where the catalog takes the
// account-prefixed warehouse. They are not interchangeable and each 404s on the
// other's form -- iceberg_r2.py's catalog() carries the same warning.
const WAREHOUSE_BUCKET = process.env.R2_SQL_BUCKET ?? "metagraphed-lakehouse";
const ACCOUNT_ID =
  process.env.R2_ACCOUNT_ID ?? "918f0f0e2eb26709d1cf4fb76085c8fb";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface FreshnessRule {
  /** How old the newest snapshot may be, or null when staleness is meaningless. */
  maxAgeMs: number | null;
  /** Why this bound, in the producer's own terms. */
  reason: string;
}

/**
 * Every table in `chain`, and how stale each may be.
 *
 * The bounds are the PRODUCER's cadence plus room for a missed pass, the same
 * shape `missedTicksMs` gives the Neon watchdogs. A decode lane that appends
 * continuously is bounded in hours; a daily rollup in days.
 *
 * The nineteen frozen ones are declared at the cadence they are SUPPOSED to
 * run at, not at their current age -- a watchdog calibrated to the outage it
 * is watching would report success forever. They fail today, and that is
 * correct: JSONbored/metagraphed-infra#510 restores the producers, and this is
 * what proves each restore stayed alive.
 */
export const EXPECTED: Readonly<Record<string, FreshnessRule>> = {
  // The four the decoder appends to, continuously.
  blocks: { maxAgeMs: 6 * HOUR, reason: "decoder appends per block batch" },
  extrinsics: { maxAgeMs: 6 * HOUR, reason: "decoder appends per block batch" },
  chain_events: {
    maxAgeMs: 6 * HOUR,
    reason: "decoder appends per block batch",
  },
  account_events: {
    maxAgeMs: 6 * HOUR,
    reason: "decoder appends per block batch",
  },
  // The daily rollup's three.
  neuron_daily: {
    maxAgeMs: 2 * DAY,
    reason: "daily_rollup_r2.py, one pass a day",
  },
  account_position_daily: {
    maxAgeMs: 2 * DAY,
    reason: "daily_rollup_r2.py, one pass a day",
  },
  subnet_snapshots: {
    maxAgeMs: 2 * DAY,
    reason: "daily_rollup_r2.py, one pass a day",
  },
  // Frozen since the 2026-08-02 exodus. Bounds are what the producer SHOULD
  // hold once restored -- see the note above on not calibrating to the outage.
  account_balances: {
    maxAgeMs: 2 * DAY,
    reason: "balance poller, restore pending",
  },
  account_events_daily: {
    maxAgeMs: 2 * DAY,
    reason: "daily rollup, restore pending",
  },
  account_identity: {
    maxAgeMs: 2 * DAY,
    reason: "identity poller, restore pending",
  },
  account_identity_history: {
    maxAgeMs: 2 * DAY,
    reason: "identity poller, restore pending",
  },
  featured_validators: {
    maxAgeMs: 7 * DAY,
    reason: "registry projection, restore pending",
  },
  neurons: { maxAgeMs: 2 * DAY, reason: "metagraph poller, restore pending" },
  nominator_positions: {
    maxAgeMs: 2 * DAY,
    reason: "validator_nominators poller, restore pending",
  },
  providers: {
    maxAgeMs: 7 * DAY,
    reason: "registry projection, restore pending",
  },
  rpc_proxy_events: {
    maxAgeMs: 2 * DAY,
    reason: "rpc proxy sink, restore pending",
  },
  self_health_daily: {
    maxAgeMs: 2 * DAY,
    reason: "self-health rollup, restore pending",
  },
  subnet_hyperparams: {
    maxAgeMs: 2 * DAY,
    reason: "hyperparams poller, restore pending",
  },
  subnet_hyperparams_history: {
    maxAgeMs: 2 * DAY,
    reason: "hyperparams poller, restore pending",
  },
  subnet_identity_history: {
    maxAgeMs: 2 * DAY,
    reason: "identity poller, restore pending",
  },
  // Created 2026-08-13 so the archive holds the current-state table it already
  // held the HISTORY of -- the lakehouse could say what a subnet's identity used
  // to be and not what it is (#11089).
  // The fifteen created 2026-08-13 to close the archive gap
  // (metagraphed-infra#552). All are state-mirror tables: digest-gated, so a
  // tick where nothing changed writes no snapshot at all. The threshold is
  // therefore about how often the SOURCE moves, not how often the lane runs --
  // a 2-day ceiling on tables the poller touches hourly, wider where the
  // underlying fact genuinely changes rarely.
  chain_concentration_daily: {
    maxAgeMs: 2 * DAY,
    reason: "state mirror, digest-gated",
  },
  compute_declarations: {
    maxAgeMs: 14 * DAY,
    reason:
      "state mirror, digest-gated: this changes only when a subnet's declaration does",
  },
  emission_flow_watch: {
    maxAgeMs: 14 * DAY,
    reason:
      "state mirror, digest-gated: this changes only when a subnet's declaration does",
  },
  emission_gate_param_history: {
    maxAgeMs: 2 * DAY,
    reason: "state mirror, digest-gated",
  },
  hotkey_alpha: {
    maxAgeMs: 2 * DAY,
    reason: "state mirror, digest-gated",
  },
  revenue_observations: {
    maxAgeMs: 2 * DAY,
    reason: "state mirror, digest-gated",
  },
  subnet_deregistration_daily: {
    maxAgeMs: 2 * DAY,
    reason: "state mirror, digest-gated",
  },
  subnet_emission_enabled_history: {
    maxAgeMs: 14 * DAY,
    reason:
      "state mirror, digest-gated: this changes only when a subnet's declaration does",
  },
  subnet_lifecycle: {
    maxAgeMs: 14 * DAY,
    reason:
      "state mirror, digest-gated: this changes only when a subnet's declaration does",
  },
  surface_failure_daily: {
    maxAgeMs: 2 * DAY,
    reason: "state mirror, digest-gated",
  },
  surface_history: {
    maxAgeMs: 2 * DAY,
    reason: "state mirror, digest-gated",
  },
  surface_uptime_daily: {
    maxAgeMs: 2 * DAY,
    reason: "state mirror, digest-gated",
  },
  tao_usd_index: {
    maxAgeMs: 2 * DAY,
    reason: "state mirror, digest-gated",
  },
  treasury_readings: {
    maxAgeMs: 14 * DAY,
    reason:
      "state mirror, digest-gated: this changes only when a subnet's declaration does",
  },
  // The only table mirrored on a COMPOSITE watermark: observed_at alone ties
  // 94,208 times here, so (observed_at, netuid) is what identifies a row.
  // Burn is re-read every poller pass, so this moves continuously.
  subnet_burn_history: {
    maxAgeMs: 2 * DAY,
    reason: "state mirror, composite watermark on (observed_at, netuid)",
  },
  subnet_identity: {
    maxAgeMs: 2 * DAY,
    reason: "state mirror, digest-gated: identity changes are rare",
  },
  subnet_ownership: {
    maxAgeMs: 2 * DAY,
    reason: "ownership poller, restore pending",
  },
  subnet_ownership_history: {
    maxAgeMs: 2 * DAY,
    reason: "ownership poller, restore pending",
  },
  subnets: {
    maxAgeMs: 7 * DAY,
    reason: "registry projection, restore pending",
  },
  surfaces: {
    maxAgeMs: 7 * DAY,
    reason: "registry projection, restore pending",
  },
  validator_nominator_counts: {
    maxAgeMs: 2 * DAY,
    reason: "validator_nominators poller, restore pending",
  },
  // Staleness is meaningless here, and saying so is a classification.
  rehearsal: {
    maxAgeMs: null,
    reason: "a migration rehearsal fixture: written once, by hand, on purpose",
  },
};

/**
 * The tables known frozen by the 2026-08-02 exodus, and the ONLY ones allowed
 * to be stale. THE SET ONLY SHRINKS.
 *
 * Shipping this simply red -- eighteen failures every morning until the
 * restores land -- would make it noise, and a watchdog nobody reads is the
 * failure mode that let eleven days pass. So the known outage is a BASELINE
 * rather than a pass: a table NOT on this list going stale fails immediately,
 * which is the regression case, and a table on this list that comes BACK fails
 * too, because a stale entry means the baseline is lying about the outage's
 * size.
 *
 * Same shape as this repo's other ratchets (`unreferenced-exports`,
 * `untyped-lakehouse-reads`): the number only falls, and the epic's progress is
 * measured by it falling. JSONbored/metagraphed-infra#510 restores the
 * producers; each restore deletes a line here.
 *
 * `rehearsal` is NOT here -- it is exempt in EXPECTED, which is a different
 * claim: "this cannot go stale" rather than "this is stale and we know".
 */
export const KNOWN_FROZEN: ReadonlySet<string> = new Set([
  // Was eighteen, then three, now one. `account_events_daily` gained a producer
  // (metagraphed-infra#544) and `rpc_proxy_events` gained the Analytics Engine
  // export (#547); both are writing on the tick, so the baseline must stop
  // claiming they are frozen or it overstates the outage.
  //
  // `featured_validators` is the last, and it is not waiting on a producer: the
  // curation moved to registry/featured-validators.json (#11080), so the
  // lakehouse copy is a fossil of the retired side table. It stays here until
  // that is either fed from the registry or dropped -- a decision, not a lane.
  // Was eighteen. metagraphed-infra#536 ported the Neon -> Iceberg sink that
  // the 2026-08-02 host retirement took with it, and fifteen of these came
  // back on 2026-08-13 -- verified against the catalog, 11 -> 22 chain tables
  // with a snapshot inside 24h.
  //
  // The three left are not waiting on that sink, and none of them is Neon's to
  // give:
  //   account_events_daily  a rollup over chain.account_events, which is LIVE
  //                         here (454M rows) -- derived, not mirrored
  //   featured_validators   no such table in Neon; it is registry curation
  //                         published from this repo
  //   rpc_proxy_events      no such table in Neon; the RPC proxy Worker writes
  //                         it to D1
  "featured_validators",
]);
export interface TableAge {
  table: string;
  newestMs: number | null;
  ageMs: number | null;
}

/** The verdict for one table, as a pure function so the rule is testable. */
export function evaluate(
  age: TableAge,
  rule: FreshnessRule | undefined,
): { ok: boolean; detail: string } {
  if (!rule) {
    return {
      ok: false,
      detail: `${age.table} is not classified in EXPECTED -- add a bound or an explicit null with a reason`,
    };
  }
  if (rule.maxAgeMs === null)
    return { ok: true, detail: `${age.table}: exempt (${rule.reason})` };
  if (age.newestMs === null) {
    return {
      ok: false,
      detail: `${age.table} has NO snapshots at all (${rule.reason})`,
    };
  }
  const days = (age.ageMs ?? 0) / DAY;
  if ((age.ageMs ?? 0) > rule.maxAgeMs) {
    return {
      ok: false,
      detail: `${age.table} last written ${days.toFixed(1)}d ago, over its ${(rule.maxAgeMs / DAY).toFixed(1)}d bound (${rule.reason})`,
    };
  }
  return { ok: true, detail: `${age.table}: ${days.toFixed(1)}d` };
}

interface SchemaField {
  id?: number;
  name?: string;
  type?: unknown;
}

/**
 * Columns whose TYPE changed between schema generations.
 *
 * R2 SQL tolerates schema AUGMENTATION -- adding a column -- and rejects a type
 * change outright: "Query spans incompatible schemas". Iceberg permits the
 * widening, so `int -> long` and `float -> double` look free and are not: every
 * data file written under the old schema stays unreadable until it is rewritten.
 *
 * THIS IS THE THIRD TIME IT WAS FOUND BY HAND. `neuron_daily.take` broke reads
 * for hours before anyone noticed (metagraphed-infra#542); `neurons.take` broke
 * the moment it was widened; `nominator_positions.share_fraction` sat broken
 * through several verification passes because the SMOKE TESTS DID NOT SPAN.
 *
 * METADATA ALONE IS NOT ENOUGH, and the first version of this got it wrong.
 * Iceberg keeps every historical schema in `schemas[]` FOREVER, so a table that
 * has been rewritten under its current schema still lists the old one -- this
 * reported five tables I had just fixed. The list records that a type once
 * changed, not that any data file still carries the old type.
 *
 * So metadata is the cheap FILTER and a probe is the authority. The probe is
 * `count(<column>)`, which must project the column and read every file: it
 * cannot be answered from statistics like `count(*)`, and cannot be satisfied
 * by one file like `SELECT col LIMIT 1`. Those are precisely the two shapes
 * that passed while `nominator_positions.share_fraction` was broken for its
 * real cold-tier read.
 */
/** Ask R2 SQL whether a column is actually unreadable across generations. */
async function columnSpansGenerations(
  auth: Record<string, string>,
  table: string,
  column: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.sql.cloudflarestorage.com/api/v1/accounts/${ACCOUNT_ID}/r2-sql/query/${WAREHOUSE_BUCKET}`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          warehouse: WAREHOUSE_BUCKET,
          query: `SELECT count(${column}) AS n FROM chain.${table}`,
        }),
      },
    );
    const body = (await res.json()) as {
      errors?: { message?: string }[];
    };
    return (body.errors ?? []).some((e) =>
      (e.message ?? "").includes("spans incompatible schemas"),
    );
  } catch {
    // A probe that cannot run must not silently clear the table.
    return true;
  }
}

export function typeChangedAcrossSchemas(
  metadata:
    | {
        schemas?: { "schema-id"?: number; fields?: SchemaField[] }[];
        "current-schema-id"?: number;
      }
    | undefined,
): string[] {
  const schemas = metadata?.schemas ?? [];
  if (schemas.length < 2) return [];
  const current =
    schemas.find((s) => s["schema-id"] === metadata?.["current-schema-id"]) ??
    schemas[schemas.length - 1];
  const currentType = new Map<number, string>();
  const currentName = new Map<number, string>();
  for (const field of current?.fields ?? []) {
    if (typeof field.id === "number") {
      currentType.set(field.id, JSON.stringify(field.type));
      currentName.set(field.id, String(field.name ?? field.id));
    }
  }
  const changed = new Set<string>();
  for (const schema of schemas) {
    if (schema === current) continue;
    for (const field of schema.fields ?? []) {
      if (typeof field.id !== "number") continue;
      const now = currentType.get(field.id);
      // A field ABSENT from the current schema was dropped; one absent from an
      // older schema was added. Both are augmentation, which R2 SQL reads fine.
      // Only a field in both with a different type breaks it.
      if (now === undefined) continue;
      if (now !== JSON.stringify(field.type)) {
        // The CURRENT name, not the one the old generation used. Iceberg
        // identifies a column by id, so a rename keeps the id -- and the name
        // that belongs in the error is the one someone would put in a query.
        changed.add(
          currentName.get(field.id) ?? String(field.name ?? field.id),
        );
      }
    }
  }
  return [...changed].sort();
}

async function main(): Promise<void> {
  const token = process.env.R2_CATALOG_TOKEN ?? "";
  if (!token) {
    // Loud, not skipped: a freshness check that quietly passes without a token
    // is the "gate that cannot fail" this repo has been bitten by before.
    process.stderr.write(
      "R2_CATALOG_TOKEN is required -- this reads the live catalog.\n",
    );
    process.exit(1);
  }
  const auth = { authorization: `Bearer ${token}` };
  const config = (await (
    await fetch(
      `${BASE}/v1/config?warehouse=${encodeURIComponent(WAREHOUSE)}`,
      { headers: auth },
    )
  ).json()) as { overrides?: { prefix?: string } };
  const prefix = config.overrides?.prefix;
  if (!prefix) {
    process.stderr.write("catalog /v1/config returned no prefix\n");
    process.exit(1);
  }
  const listed = (await (
    await fetch(`${BASE}/v1/${prefix}/namespaces/chain/tables`, {
      headers: auth,
    })
  ).json()) as { identifiers?: { name: string }[] };
  const tables = (listed.identifiers ?? []).map((i) => i.name).sort();

  const now = Date.now();
  const failures: string[] = [];
  // Kept SEPARATE from `failures`: an unreadable column is not a staleness
  // problem, and folding it in made the summary report "6 stale" when exactly
  // one table was stale. A watchdog that miscounts its own findings is one
  // people learn to discount.
  const unreadable: string[] = [];
  const lines: string[] = [];
  for (const table of tables) {
    const meta = (await (
      await fetch(`${BASE}/v1/${prefix}/namespaces/chain/tables/${table}`, {
        headers: auth,
      })
    ).json()) as {
      metadata?: {
        snapshots?: { "timestamp-ms"?: number }[];
        schemas?: { "schema-id"?: number; fields?: SchemaField[] }[];
        "current-schema-id"?: number;
      };
    };
    // Candidates from metadata, confirmed by probe -- see the note above on why
    // the metadata list alone reports tables that are already fine.
    const candidates = typeChangedAcrossSchemas(meta.metadata);
    const spanned: string[] = [];
    for (const column of candidates) {
      if (await columnSpansGenerations(auth, table, column)) {
        spanned.push(column);
      }
    }
    if (spanned.length) {
      unreadable.push(
        `${table}: R2 SQL cannot read ${spanned.join(", ")} -- the column's ` +
          `TYPE changed across schema generations and data files still carry ` +
          `the old one. Rewrite the table under its current schema.`,
      );
    }
    const snapshots = meta.metadata?.snapshots ?? [];
    const newestMs = snapshots.length
      ? Math.max(...snapshots.map((s) => s["timestamp-ms"] ?? 0))
      : null;
    const verdict = evaluate(
      { table, newestMs, ageMs: newestMs === null ? null : now - newestMs },
      EXPECTED[table],
    );
    lines.push(`${verdict.ok ? "ok  " : "STALE"} ${verdict.detail}`);
    if (!verdict.ok) failures.push(verdict.detail);
  }
  process.stdout.write(lines.join("\n") + "\n");

  const staleNames = new Set(failures.map((f) => f.split(" ")[0] ?? ""));
  // A table that has COME BACK must leave the baseline, or the baseline stops
  // describing the outage. Computed, never asserted.
  const recovered = [...KNOWN_FROZEN].filter(
    (t) => tables.includes(t) && !staleNames.has(t),
  );
  const regressions = failures.filter(
    (f) => !KNOWN_FROZEN.has(f.split(" ")[0] ?? ""),
  );
  reportUnreadable(unreadable);
  process.stdout.write(
    `\nlakehouse-freshness: ${failures.length} stale of ${tables.length} -- ` +
      `${failures.length - regressions.length} known (baseline ${KNOWN_FROZEN.size}), ` +
      `${regressions.length} NEW, ${recovered.length} recovered.\n`,
  );
  if (recovered.length > 0) {
    process.stderr.write(
      "\nRECOVERED -- delete these from KNOWN_FROZEN so the baseline keeps shrinking:\n" +
        recovered.map((t) => `  ${t}`).join("\n") +
        "\n",
    );
  }
  if (regressions.length === 0 && recovered.length === 0) return;
  const failures_ = regressions;
  const webhook = process.env.LIVE_ALERT_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          content:
            `⚠️ metagraphed: ${failures_.length} lakehouse table(s) NEWLY past their freshness bound.\n` +
            failures_
              .slice(0, 10)
              .map((f) => `• ${f}`)
              .join("\n") +
            `\nA frozen table still RETURNS ROWS -- the cold tier serves them with no decline (#11048).`,
        }),
      });
    } catch (err) {
      process.stderr.write(
        `alert webhook failed: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }
  process.stderr.write(
    `\nlakehouse-freshness: ${failures.length} of ${tables.length} table(s) STALE.\n`,
  );
  process.exit(1);
}

/**
 * Report unreadable columns and decide the exit code.
 *
 * Reported SEPARATELY from staleness because they are different faults with
 * different fixes: a stale table needs its producer looked at, an unreadable
 * column needs the table rewritten. Folding them together made the summary say
 * "6 stale" when one table was stale, and a watchdog that miscounts its own
 * findings is one people learn to discount.
 */
function reportUnreadable(unreadable: string[]): void {
  if (!unreadable.length) return;
  process.stdout.write(
    `\nUNREADABLE -- ${unreadable.length} table(s) span incompatible schemas:\n  ` +
      unreadable.join("\n  ") +
      `\n  R2 SQL tolerates adding a column and rejects a type change. Rewrite\n` +
      `  each table under its current schema; Iceberg keeps the old schema in\n` +
      `  its metadata either way, so only a probe can tell you it is fixed.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
