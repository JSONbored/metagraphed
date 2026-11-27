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
    "alpha_assets",
    "api_key_blocks",
    "api_key_usage_daily",
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
    "chain_gamma",
    "child_keys_history",
    "childkey_takes",
    "childkey_thresholds",
    "coldkey_swap_announcements",
    "coldkey_swap_policy",
    "compute_declarations",
    "emission_flow_watch",
    "emission_gate_param_history",
    "evm_associations",
    "gamma_deposits",
    "gamma_events",
    "generated_artifacts",
    "github_accounts",
    "hotkey_alpha",
    "hotkey_alpha_passes",
    "iceberg_catalog_namespaces",
    "iceberg_catalog_tables",
    "key_successors",
    "lane_health",
    "lane_health_clocks",
    "lane_health_current",
    "lane_health_verdict_latest",
    "limit_order_events",
    "limit_orders",
    "multisigs",
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
    "pending_child_keys",
    "providers",
    "proxies",
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
    "stake_locks",
    "subnet_alpha_dividends",
    "subnet_burn_history",
    "subnet_deregistration_daily",
    "subnet_emission_enabled_history",
    "subnet_gamma",
    "subnet_hyperparams",
    "subnet_hyperparams_history",
    "subnet_identity",
    "subnet_identity_history",
    "subnet_lifecycle",
    "subnet_mechanisms",
    "subnet_ownership",
    "subnet_ownership_history",
    "subnet_services",
    "subnet_snapshots",
    "subnets",
    "surface_checks",
    "surface_failure_daily",
    "surface_history",
    "surface_status",
    "surface_uptime_daily",
    "surfaces",
    "swap_balancer",
    "sync_dead_letters",
    "tao_usd_index",
    "tao_usd_oracle",
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
  // The chain core (ADR 0029, migration 0057): finalized chain facts, written
  // by the producer profile's chain-detail lane and read by everything else.
  chain: Object.freeze([
    "account_events",
    "accounts",
    "blocks",
    "calls",
    "coverage",
    "event_kinds",
    "events",
    "extrinsics",
    "networks",
  ]),
  // The chain core's rows in the shapes the API's formatters read
  // (migration 0058): views, so a read-only source of their own.
  chain_views: Object.freeze([
    "account_event_rows",
    "block_rows",
    "chain_event_rows",
    "extrinsic_rows",
  ]),
});
export type NativeSourceName = keyof typeof NATIVE_SOURCE_RELATIONS;
/** A `_views` source is the read-only views of the schema its name begins with. */
export type NativeSchemaName = Exclude<
  NativeSourceName,
  "retained_views" | "chain_views"
>;
const VIEW_SOURCES: Readonly<Record<string, NativeSchemaName>> = Object.freeze({
  retained_views: "retained",
  chain_views: "chain",
});
export type NativeSourceOwners = Readonly<Record<NativeSchemaName, string>>;

/** Which credential a composed process presents (infra#882). "trusted" is the
 * producer/scheduler composition: every source read-write, as today. "serving"
 * is the public HTTP composition: reads everywhere, writes only the user-state
 * relations below -- so the narrow serving role passes startup verification
 * with exactly its own grants and a leaked serving credential cannot touch
 * acquisition, custody or retained history. */
export type NativeProcessProfile = "trusted" | "serving" | "producer";

/** The relations the PUBLIC SERVING process writes, per schema -- user state
 * a request legitimately mutates (keys/quota/usage accounting, alert and push
 * registrations, rate limiting, MCP sessions, request-driven usage capture,
 * webhook enqueue). Everything else the serving role only reads. The real-role
 * fixture (tests/native-capability-split.pg18.ts) is the qualification: a
 * serving store writing outside this list fails startup verification with the
 * relation named, which is the fail-closed readiness reason infra#882 asks
 * for -- extend the list in the same change that adds the write. */
export const NATIVE_SERVING_WRITES: Readonly<
  Record<NativeSchemaName, readonly string[]>
> = Object.freeze({
  app: Object.freeze([
    "api_key_blocks",
    "api_key_usage_daily",
    "api_quota_daily",
    "api_usage_rollup",
    "api_usage_rollup_batches",
    // The chain-firehose owner lives in the SERVING composition (infra#882
    // part-2 decision): its idempotent head upsert and its own actor row are
    // the two bounded writes that keep chain streams on one listener process.
    // SINGLE-WRITER: the producer profile must never also declare these two.
    "blocks_head",
    "chain_alert_deliveries",
    "chain_alert_triggers",
    // Login upserts run on the serving path until the infra#820 step-3
    // re-point moves identity onto the producer plane; api_keys is absent
    // deliberately -- the colliding twin retires in 0056 and key management
    // lands on the producer functions at step 3 (#13040).
    "github_accounts",
    "rpc_accounts",
    "rpc_usage_events",
    "watch_push_subscriptions",
  ]),
  auth: Object.freeze([
    "kv_entries",
    "rate_limit_buckets",
    "rate_limit_policies",
  ]),
  jobs: Object.freeze(["messages", "queues"]),
  realtime: Object.freeze([
    // The realtime actor component (status -> sessions <-> chain <-> alerter)
    // is one in-process graph -- splitting it would need exactly the
    // inter-process paths the part-2 decision rejected -- so the whole
    // component lives in the SERVING composition and its two remaining actor
    // leases join the declared writes (single-writer, like the chain pair).
    "alerter_owner",
    "chain_firehose_actor",
    "mcp_capacity",
    "mcp_sessions",
    "subnet_status_actor",
  ]),
  retained: Object.freeze([]),
  search: Object.freeze([]),
  chain: Object.freeze([]),
});

/** Relations with exactly ONE writing composition (infra#882 condition 1):
 * the serving-owned actor leases and the chain head. The producer profile is
 * DERIVED by excluding these from its write set, so the two profiles cannot
 * drift into a double-writer without the derivation (and its test) failing. */
export const NATIVE_SINGLE_WRITER_SERVING: Readonly<
  Partial<Record<NativeSchemaName, readonly string[]>>
> = Object.freeze({
  app: Object.freeze(["blocks_head"]),
  realtime: Object.freeze([
    "alerter_owner",
    "chain_firehose_actor",
    "mcp_capacity",
    "mcp_sessions",
    "subnet_status_actor",
  ]),
});

export function nativeSourceDefinitions(
  owners: NativeSourceOwners,
  profile: NativeProcessProfile = "trusted",
): readonly NativeSourceDefinition[] {
  const schemas: NativeSchemaName[] = [
    "app",
    "auth",
    "chain",
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
      const schema = (VIEW_SOURCES[name] ?? name) as NativeSchemaName;
      const writes = Object.hasOwn(VIEW_SOURCES, name)
        ? []
        : profile === "trusted"
          ? relations
          : profile === "serving"
            ? NATIVE_SERVING_WRITES[schema]
            : relations.filter(
                (relation) =>
                  !(NATIVE_SINGLE_WRITER_SERVING[schema] ?? []).includes(
                    relation,
                  ),
              );
      return Object.freeze({
        name,
        schema,
        owner: owners[schema],
        relations,
        access:
          writes.length === 0 ? ("read" as const) : ("read-write" as const),
        // The trusted process writes everything, which `writable` absent
        // means; the serving process pins its exact set.
        ...(profile !== "trusted" && writes.length > 0
          ? { writable: writes }
          : {}),
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

/** A source a process only reads must not reach its schema's owner authority:
 * a SECURITY DEFINER function runs as the schema's owner, so EXECUTE on one
 * (chain.drop_partitions_below drops partitions) is a write the read-only
 * credential would otherwise hold. The deployment grants EXECUTE to its
 * writers alone; a serving process that can still call one refuses to start. */
export async function assertNativeDefinerPrivileges(
  sources: ReadonlyMap<string, NativeSource>,
): Promise<void> {
  // A schema the same process also writes (a `_views` source beside its
  // table source, in the trusted profile) holds its writer's EXECUTE by
  // right; only a schema it reads alone must not reach owner authority.
  const written = new Set(
    (Object.keys(NATIVE_SOURCE_RELATIONS) as NativeSourceName[])
      .map((name) => nativeSource(sources, name))
      .filter((source) => source.access === "read-write")
      .map((source) => source.schema),
  );
  for (const name of Object.keys(
    NATIVE_SOURCE_RELATIONS,
  ) as NativeSourceName[]) {
    const source = nativeSource(sources, name);
    if (source.access !== "read" || written.has(source.schema)) continue;
    const callable = await source.read.query<{ name: string }>(
      `SELECT p.proname AS name FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.prosecdef
         AND has_function_privilege(current_user, p.oid, 'EXECUTE')
       ORDER BY 1`,
      [source.schema],
    );
    if (callable.length > 0)
      throw new Error(
        `Native ${name} source can run owner-authority functions: ${callable
          .map((row) => row.name)
          .join(", ")}`,
      );
  }
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
    // infra#882: generated-ID readiness follows the declared write set -- a
    // serving process needs no sequence on tables it only reads.
    const writable = [...(source.writable ?? source.relations)];
    if (writable.length === 0) continue;
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
      [source.schema, writable],
    );
    for (const sequence of sequences)
      if (sequence.writable !== true)
        throw new Error(
          `Native ${name} sequence privilege is unavailable for ${sequence.relation}`,
        );
  }
}
