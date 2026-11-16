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
      // gamma_events is served through the account events feed, not its own
      // route -- src/account-events.ts reads it into the feed contract.
      { file: "src/account-events.ts", symbol: "gamma_events" },
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
      { file: "src/account-events.ts", symbol: "limit_order_events" },
    ],
  },
  "0051_evm_associations.sql": {
    tables: ["app.evm_associations"],
    anchors: [
      {
        file: "schemas-src/routes/network-singletons.ts",
        symbol: "EvmAssociationSchema",
      },
      { file: "schemas-src/mcp-tools/evm.ts", symbol: "evm" },
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

function createdTables(sql: string): string[] {
  return [
    ...sql.matchAll(
      /CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?([a-z_]+\.[a-z_0-9]+)/g,
    ),
  ].map((match) => match[1] as string);
}

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
      if (!readFileSync(anchor.file, "utf8").includes(anchor.symbol)) {
        failures.push(
          `${file}: anchor symbol "${anchor.symbol}" not found in ${anchor.file}`,
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
