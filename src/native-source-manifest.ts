import type {
  NativeSource,
  NativeSourceDefinition,
} from "./native-api-process.ts";

/** Runtime relations only. Source ledgers, load-phase migration state and
 * retained forensic copies belong to the separate import/custody process. */
export const NATIVE_SOURCE_RELATIONS = Object.freeze({
  app: Object.freeze([
    "account_balances",
    "account_balances_passes",
    "account_identity",
    "account_identity_history",
    "account_position_daily_documents",
    "account_position_daily_members",
    "api_key_blocks",
    "api_key_usage_daily",
    "api_keys",
    "api_quota_daily",
    "api_usage_rollup",
    "api_usage_rollup_batches",
    "archive_export_revisions",
    "attribution_candidates",
    "attribution_sweeps",
    "blocks_head",
    "chain_alert_deliveries",
    "chain_alert_triggers",
    "chain_concentration_daily",
    "chain_detail_account_events",
    "chain_detail_blocks",
    "chain_detail_chain_events",
    "chain_detail_extrinsics",
    "chain_detail_payload_chunks",
    "compute_declarations",
    "emission_flow_watch",
    "emission_gate_param_history",
    "generated_artifacts",
    "github_accounts",
    "hotkey_alpha",
    "hotkey_alpha_passes",
    "iceberg_catalog_namespaces",
    "iceberg_catalog_tables",
    "lane_health",
    "lane_health_clocks",
    "lane_health_current",
    "lane_health_verdict_latest",
    "native_export_revisions",
    "neuron_daily_documents",
    "neuron_daily_members",
    "neuron_document_projections",
    "neurons_capture_batches",
    "neurons_documents",
    "neurons_members",
    "neurons_passes",
    "nominator_positions",
    "nominator_positions_passes",
    "nominator_scan_receipts",
    "origin_reachability",
    "providers",
    "raw_capture_archives",
    "raw_capture_batches",
    "raw_capture_budget",
    "raw_capture_chunks",
    "raw_capture_publications",
    "raw_capture_selected",
    "raw_capture_state",
    "revenue_observations",
    "revenue_probe_failures",
    "root_basket_capture_completions",
    "root_basket_capture_pages",
    "root_basket_captures",
    "root_basket_current",
    "root_basket_fund_snapshots",
    "root_basket_holdings",
    "root_basket_targets",
    "rpc_accounts",
    "rpc_usage_archive_days",
    "rpc_usage_events",
    "rpc_usage_prune_state",
    "self_health_checks",
    "self_health_daily",
    "subnet_burn_history",
    "subnet_deregistration_daily",
    "subnet_emission_enabled_history",
    "subnet_hyperparams",
    "subnet_hyperparams_history",
    "subnet_identity",
    "subnet_identity_history",
    "subnet_lifecycle",
    "subnet_ownership",
    "subnet_ownership_history",
    "subnet_snapshots",
    "subnets",
    "surface_checks",
    "surface_failure_daily",
    "surface_history",
    "surface_status",
    "surface_uptime_daily",
    "surfaces",
    "sync_dead_letters",
    "tao_usd_index",
    "treasury_readings",
    "validator_nominator_counts",
    "validator_nominator_counts_passes",
    "watch_push_subscriptions",
  ]),
  auth: Object.freeze([
    "kv_entries",
    "rate_limit_buckets",
    "rate_limit_policies",
  ]),
  jobs: Object.freeze([
    "capacity",
    "cron_policy",
    "cron_runs",
    "cron_schedules",
    "cron_skips",
    "deliveries",
    "messages",
    "queues",
  ]),
  realtime: Object.freeze([
    "alerter_owner",
    "chain_firehose_actor",
    "mcp_capacity",
    "mcp_sessions",
    "subnet_status_actor",
  ]),
  retained: Object.freeze([
    "history_block_authors",
    "history_block_chunks",
    "history_block_counts",
    "history_block_source_counts",
    "history_block_sources",
    "history_block_state",
    "history_blocks",
  ]),
  retained_views: Object.freeze(["history_block_rows"]),
  search: Object.freeze(["indexes", "vectors"]),
});
export type NativeSourceName = keyof typeof NATIVE_SOURCE_RELATIONS;
export type NativeSchemaName = Exclude<NativeSourceName, "retained_views">;
export type NativeSourceOwners = Readonly<Record<NativeSchemaName, string>>;

export function nativeSourceDefinitions(
  owners: NativeSourceOwners,
): readonly NativeSourceDefinition[] {
  const schemas: NativeSchemaName[] = [
    "app",
    "auth",
    "jobs",
    "realtime",
    "retained",
    "search",
  ];
  if (
    !owners ||
    typeof owners !== "object" ||
    Array.isArray(owners) ||
    Object.keys(owners).some((key) => !(schemas as string[]).includes(key))
  )
    throw new TypeError(
      "Native source owners must contain only declared schemas",
    );
  for (const schema of schemas) {
    if (
      typeof owners[schema] !== "string" ||
      !/^[a-z_][a-z0-9_]{0,62}$/.test(owners[schema])
    )
      throw new TypeError(`Native ${schema} source owner is required`);
  }
  return Object.freeze(
    Object.entries(NATIVE_SOURCE_RELATIONS).map(([name, relations]) => {
      const schema = (
        name === "retained_views" ? "retained" : name
      ) as NativeSchemaName;
      return Object.freeze({
        name,
        schema,
        owner: owners[schema],
        relations,
        access:
          name === "retained_views"
            ? ("read" as const)
            : ("read-write" as const),
      });
    }),
  );
}

export function nativeSource(
  sources: ReadonlyMap<string, NativeSource>,
  name: NativeSourceName,
): NativeSource {
  const source = sources.get(name);
  if (!source) throw new Error(`Native ${name} source is unavailable`);
  return source;
}

/** Table grants alone do not establish permission to allocate a generated ID. */
export async function assertNativeSequencePrivileges(
  sources: ReadonlyMap<string, NativeSource>,
): Promise<void> {
  for (const name of Object.keys(
    NATIVE_SOURCE_RELATIONS,
  ) as NativeSourceName[]) {
    const source = nativeSource(sources, name);
    if (source.access !== "read-write") continue;
    const sequences = await source.read.query<{
      relation: string;
      sequence: string;
      writable: boolean;
    }>(
      `SELECT t.relname AS relation,s.relname AS sequence,
        (has_sequence_privilege(current_user,s.oid,'USAGE') OR
         has_sequence_privilege(current_user,s.oid,'UPDATE')) AS writable
       FROM pg_catalog.pg_class t
       JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
       JOIN pg_catalog.pg_depend d ON d.refobjid=t.oid
         AND d.refclassid='pg_catalog.pg_class'::regclass
         AND d.classid='pg_catalog.pg_class'::regclass AND d.deptype IN ('a','i')
       JOIN pg_catalog.pg_class s ON s.oid=d.objid AND s.relkind='S'
       WHERE n.nspname=$1 AND t.relname=ANY($2::text[])`,
      [source.schema, source.relations],
    );
    for (const sequence of sequences)
      if (sequence.writable !== true)
        throw new Error(
          `Native ${name} sequence privilege is unavailable for ${sequence.relation}`,
        );
  }
}
