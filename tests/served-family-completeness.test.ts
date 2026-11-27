// The served-family completeness gate (infra#873 follow-on, 2026-11-16).
//
// "Is every serving-schema family covered by a contract?" was a grep until a
// stale answer to exactly that question was asserted on the record (the
// evm_associations rows were called contract-less a day after #13165 shipped
// their DTO, route, GraphQL mirror and MCP tool). This test turns the
// question into a refusing check:
//
//   - EVERY migration file in migrations/postgres must be declared below --
//     either with its contract anchors (each verified to exist on disk, with
//     the named symbol present) or in the pinned pre-gate backlog.
//   - EVERY table a declared file creates must be enumerated in its entry, so
//     a new table slipped into an existing family fails too.
//   - The backlog is a ratchet: it lists the exact legacy-port files that
//     predate the gate. It can only shrink -- a new file landing without
//     anchors fails; adding to the backlog fails by construction because the
//     list is pinned here and reviewed.
//
// A new engine row that lands a table without a surface therefore fails CI in
// the PR that lands it, with this file naming what it must declare.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { stripTsComments } from "../scripts/lib/source-text.ts";

const MIGRATIONS_DIR = "migrations/postgres";

/** One contract anchor: the file must exist and contain the symbol. */
interface Anchor {
  file: string;
  symbol: string;
}

/** A served family: its tables (exactly the CREATE TABLEs in the file) and
 * the contract anchors that serve them. `tables` may be empty for ALTER-only
 * migrations, which then need no anchors. */
interface Family {
  tables: readonly string[];
  anchors: readonly Anchor[];
}

const FAMILY_ANCHORS: Readonly<Record<string, Family>> = {
  "0037_alerter_owner.sql": {
    // Single-writer ownership row for the native alerter actor -- internal
    // coordination state, no public contract; the owning module is the anchor.
    tables: ["realtime.alerter_owner"],
    anchors: [{ file: "src/pg-alerter-owner.ts", symbol: "alerter_owner" }],
  },
  "0038_rpc_usage.sql": {
    tables: ["app.rpc_usage_events"],
    anchors: [
      { file: "src/pg-rpc-usage-reader.ts", symbol: "createPgRpcUsageReader" },
      { file: "schemas-src/route-queries.ts", symbol: "/api/v1/rpc/usage" },
    ],
  },
  "0039_restore_stable_constraints.sql": { tables: [], anchors: [] },
  "0040_native_export_revisions.sql": {
    tables: ["app.native_export_revisions"],
    anchors: [{ file: "src/native-state-export.ts", symbol: "export" }],
  },
  "0041_native_export_revisions_activate.sql": { tables: [], anchors: [] },
  "0042_rpc_usage_archive.sql": {
    // Closed-day archive rollups behind /api/v1/rpc/usage's cold windows.
    tables: ["app.rpc_usage_archive_days"],
    anchors: [{ file: "src/pg-rpc-usage-reader.ts", symbol: "rpc_usage" }],
  },
  "0043_rpc_usage_archive_prune.sql": {
    // Prune bookkeeping for the archive -- internal, owned by the store.
    tables: ["app.rpc_usage_prune_state"],
    anchors: [{ file: "src/pg-rpc-usage.ts", symbol: "prune" }],
  },
  "0044_mechanisms.sql": {
    tables: ["app.subnet_mechanisms"],
    anchors: [
      {
        file: "schemas-src/routes/subnet-mechanisms.ts",
        symbol: "SubnetMechanisms",
      },
    ],
  },
  "0045_stake_v2.sql": {
    tables: ["app.subnet_alpha_dividends", "app.stake_locks"],
    anchors: [
      {
        file: "schemas-src/routes/subnet-alpha-dividends.ts",
        symbol: "AlphaDividends",
      },
      { file: "schemas-src/routes/account-locks.ts", symbol: "Locks" },
    ],
  },
  "0046_root_basket_v490.sql": { tables: [], anchors: [] },
  "0047_gamma.sql": {
    tables: [
      "app.chain_gamma",
      "app.subnet_gamma",
      "app.gamma_deposits",
      "app.gamma_events",
      "app.subnet_services",
    ],
    anchors: [
      { file: "schemas-src/routes/chain-gamma.ts", symbol: "Gamma" },
      { file: "schemas-src/routes/gamma-deposits.ts", symbol: "GammaDeposit" },
      {
        file: "schemas-src/routes/subnet-services.ts",
        symbol: "SubnetServices",
      },
      // app.gamma_events has NO READER YET, and this entry used to claim one.
      // What exists today is forward compatibility: src/account-events.ts
      // names the Gamma event kinds so `?kind=` accepts them the day the
      // producer emits them, while the events themselves land raw-only in
      // chain_detail_chain_events and the structured decode into this table
      // lands with the engine (#13164). So the anchor is one of those kind
      // constants -- real code, and an honest description of the surface that
      // is actually in place.
      { file: "src/account-events.ts", symbol: '"GammaMinted"' },
    ],
  },
  "0048_tao_usd_oracle.sql": {
    tables: ["app.tao_usd_oracle"],
    anchors: [
      // Served through the economics artifact (TAO/USD cron writes, the
      // economics read path serves); the store is the contract boundary.
      { file: "src/pg-tao-usd-oracle.ts", symbol: "tao_usd_oracle" },
    ],
  },
  "0049_swap_liquidity.sql": {
    tables: ["app.swap_balancer", "app.alpha_assets"],
    anchors: [
      { file: "schemas-src/routes/subnet-swap.ts", symbol: "Swap" },
      {
        file: "schemas-src/routes/subnet-alpha-assets.ts",
        symbol: "AlphaAssets",
      },
    ],
  },
  "0050_limit_orders.sql": {
    tables: ["app.limit_orders", "app.limit_order_events"],
    anchors: [
      {
        file: "schemas-src/routes/subnet-limit-orders.ts",
        symbol: "LimitOrders",
      },
      // Same as 0047's gamma_events: app.limit_order_events has no reader
      // yet. OrderExecuted is named for `?kind=` forward compatibility (it has
      // 8.4M blocks of live raw history), and the structured decode into this
      // table lands with the engine (#13165).
      { file: "src/account-events.ts", symbol: '"OrderExecuted"' },
    ],
  },
  "0051_evm_associations.sql": {
    tables: ["app.evm_associations"],
    anchors: [
      {
        file: "schemas-src/routes/network-singletons.ts",
        symbol: "EvmAssociationSchema",
      },
      // A real exported schema, not the bare token "evm": that matched only
      // this file's own header comment, even though the MCP surface is
      // genuinely here.
      {
        file: "schemas-src/mcp-tools/evm.ts",
        symbol: "GetEvmAddressMappingInputSchema",
      },
      { file: "src/pg-evm-associations.ts", symbol: "evm_associations" },
    ],
  },
  "0052_identity_v2.sql": { tables: [], anchors: [] },
  "0053_coldkey_swaps.sql": {
    tables: [
      "app.coldkey_swap_announcements",
      "app.coldkey_swap_policy",
      "app.key_successors",
    ],
    anchors: [
      { file: "schemas-src/routes/coldkey-swaps.ts", symbol: "ColdkeySwap" },
    ],
  },
  "0054_child_keys.sql": {
    tables: [
      "app.childkey_takes",
      "app.pending_child_keys",
      "app.childkey_thresholds",
      "app.child_keys_history",
    ],
    anchors: [
      {
        file: "schemas-src/routes/account-child-delegation.ts",
        symbol: "Child",
      },
      { file: "src/pg-child-keys.ts", symbol: "child" },
    ],
  },
  "0055_proxies_multisigs.sql": {
    tables: ["app.proxies", "app.multisigs"],
    anchors: [
      { file: "schemas-src/route-queries.ts", symbol: "proxies" },
      { file: "schemas-src/openapi-registry.ts", symbol: "Multisig" },
    ],
  },
  // Drop-only: retires the 0010 identity staging twins per infra#820 -- the
  // producer tree owns the identity plane. Creates nothing, so no anchors.
  "0056_identity_plane_handoff.sql": { tables: [], anchors: [] },
  // The chain core (ADR 0029 phase 1a): the writer is its surface until the
  // chain-history routes read it (phase 1b), and the native source declares
  // every relation the process verifies at start.
  "0057_chain_core.sql": {
    tables: [
      "chain.networks",
      "chain.accounts",
      "chain.calls",
      "chain.event_kinds",
      "chain.blocks",
      "chain.extrinsics",
      "chain.events",
      "chain.account_events",
      "chain.coverage",
    ],
    anchors: [
      { file: "src/chain-core-pg.ts", symbol: "chain.account_events" },
      { file: "src/chain-core-pg.ts", symbol: "chain.coverage" },
      { file: "src/native-source-manifest.ts", symbol: '"event_kinds"' },
    ],
  },
};

/** The legacy-port files that predate the gate, pinned exactly. Shrink-only:
 * classify a file (move it to FAMILY_ANCHORS, or retire it) and delete its
 * row here in the same change. Never add to this list. */
const PRE_GATE_BACKLOG: readonly string[] = [
  "0000_source_metadata.sql",
  "0001_retained_blocks.sql",
  "0002_retained_sequences.sql",
  "0003_retained_feed_order.sql",
  "0004_lane_health.sql",
  "0005_lane_health_activate.sql",
  "0006_generated_artifacts.sql",
  "0007_registry_health.sql",
  "0008_registry_health_activate.sql",
  "0009_auth_kv.sql",
  "0010_account_state.sql",
  "0011_account_state_activate.sql",
  "0012_economic_history.sql",
  "0013_economic_history_activate.sql",
  "0014_account_observations.sql",
  "0015_account_observations_activate.sql",
  "0016_chain_control.sql",
  "0017_chain_control_activate.sql",
  "0018_raw_capture.sql",
  "0019_raw_capture_activate.sql",
  "0020_root_basket.sql",
  "0021_root_basket_activate.sql",
  "0022_closed_day_revisions.sql",
  "0024_neuron_documents.sql",
  "0025_neuron_documents_activate.sql",
  "0026_jobs.sql",
  "0027_closed_day_revisions_activate.sql",
  "0028_auth_rate_limits.sql",
  "0029_search_index.sql",
  "0030_cron.sql",
  "0031_subnet_status_actor.sql",
  "0032_mcp_sessions.sql",
  "0033_account_numeric.sql",
  "0034_chain_firehose_actor.sql",
  "0035_usage_row_identity.sql",
  "0036_usage_row_identity_activate.sql",
];

/**
 * TypeScript comments, dropped before an anchor is looked for. Prose is not a
 * contract surface.
 *
 * Paired with `withoutSqlComments` below, which does the same job for the
 * migration side: two functions because `--` and `//` are different languages'
 * comment syntax and the SQL one has to respect string literals. Same reason
 * for both -- a comment naming a thing is not that thing.
 */

/**
 * SQL comments, dropped before anything is read out of a migration.
 *
 * The anchor check above (`stripComments`) strips comments because a comment
 * satisfied one. The table enumeration needs the same treatment, and
 * the consequence here is the uglier one: a migration that MENTIONS a table it
 * does not create -- `-- CREATE TABLE app.legacy_x, dropped in 0039` is the
 * natural way to write that -- would have this gate demand a contract surface
 * for a table that does not exist. Whoever hit that would satisfy it by
 * inventing an anchor, which is how fiction gets into FAMILY_ANCHORS.
 *
 * Line-wise for `--` so a `--` inside a string literal is not mistaken for a
 * comment; block comments are removed outright. Nothing in migrations/postgres
 * relies on either shape today, which is exactly when to add this rather than
 * after a migration has been misread.
 */
function withoutSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote) {
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === "'" || ch === '"') {
          quote = ch;
          continue;
        }
        if (ch === "-" && line[i + 1] === "-") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

function createdTables(sql: string): string[] {
  return [
    ...withoutSqlComments(sql).matchAll(
      /CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?([a-z_]+\.[a-z_0-9]+)/g,
    ),
  ].map((match) => match[1] as string);
}

test("a table the SQL only mentions is not a table the SQL creates", () => {
  // The negative cases, which are the whole point: the enumeration above is a
  // regex over migration text, and nothing in migrations/postgres exercises
  // either shape today. Without these, stripping comments would be an
  // unverified claim.
  assert.deepEqual(
    createdTables(`-- CREATE TABLE app.legacy_x, dropped in 0039
       CREATE TABLE app.real_one (id bigint);`),
    ["app.real_one"],
    "a commented-out CREATE TABLE is being counted as created",
  );
  assert.deepEqual(
    createdTables(`/* historical: CREATE TABLE app.block_commented (x int) */
       CREATE TABLE app.real_two (id bigint);`),
    ["app.real_two"],
    "a block-commented CREATE TABLE is being counted as created",
  );
  // And a `--` inside a string literal is not a comment, so a default value
  // containing one must not truncate the statement that follows it.
  assert.deepEqual(
    createdTables(
      `CREATE TABLE app.with_default (note text DEFAULT 'a -- b');
       CREATE TABLE app.after_it (id bigint);`,
    ),
    ["app.with_default", "app.after_it"],
    "a double dash inside a string literal is being read as a comment",
  );
});

test("every serving-schema family declares its contract surface or sits in the shrinking backlog", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const failures: string[] = [];
  const backlog = new Set(PRE_GATE_BACKLOG);
  for (const file of files) {
    const declared = FAMILY_ANCHORS[file];
    if (backlog.has(file)) {
      backlog.delete(file);
      assert.equal(
        declared,
        undefined,
        `${file} is both in the backlog and FAMILY_ANCHORS -- remove its backlog row`,
      );
      continue;
    }
    if (!declared) {
      failures.push(
        `${file}: new family with no declared contract surface -- add a FAMILY_ANCHORS entry (tables + verified anchors) in this change`,
      );
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const actual = createdTables(sql).sort();
    const pinned = [...declared.tables].sort();
    if (JSON.stringify(actual) !== JSON.stringify(pinned)) {
      failures.push(
        `${file}: created tables [${actual.join(", ")}] differ from the declared [${pinned.join(", ")}] -- every table needs its surface declared`,
      );
    }
    if (declared.tables.length > 0 && declared.anchors.length === 0) {
      failures.push(`${file}: creates tables but declares no anchors`);
    }
    for (const anchor of declared.anchors) {
      if (!existsSync(anchor.file)) {
        failures.push(`${file}: anchor file missing: ${anchor.file}`);
        continue;
      }
      // CODE, NOT PROSE. A plain `includes` over the whole file let a COMMENT
      // satisfy an anchor, and that is not a hypothetical: this gate declared
      // "gamma_events is served through the account events feed --
      // src/account-events.ts reads it into the feed contract", and the only
      // occurrence of `gamma_events` in that file was the comment saying the
      // opposite ("these land raw-only in chain_detail_chain_events today, and
      // the structured decode ... lands with the engine"). Same for
      // limit_order_events. So this file's own header -- written because "a
      // stale answer to exactly that question was asserted on the record" --
      // was asserting two surfaces that do not exist, satisfied by the prose
      // denying them.
      //
      // Prose has no compiler: a comment naming a symbol reads as a reference
      // and fails nothing when the symbol never arrives. Comments are
      // therefore stripped before the anchor is looked for.
      if (
        !stripTsComments(readFileSync(anchor.file, "utf8")).includes(
          anchor.symbol,
        )
      ) {
        failures.push(
          `${file}: anchor symbol "${anchor.symbol}" not found in ${anchor.file}'s CODE` +
            " (a comment mentioning it does not count -- anchor a real symbol," +
            " or declare the surface as pending rather than served)",
        );
      }
    }
  }
  for (const stale of backlog) {
    failures.push(
      `backlog names a file that no longer exists: ${stale} -- delete its row`,
    );
  }
  for (const stale of Object.keys(FAMILY_ANCHORS)) {
    if (!files.includes(stale)) {
      failures.push(
        `FAMILY_ANCHORS names a file that no longer exists: ${stale}`,
      );
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});
