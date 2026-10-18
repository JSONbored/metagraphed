export type FreshnessPhase =
  "arguments" | "catalog" | "evidence" | "evaluation";

export interface FreshnessCounts {
  tables: number;
  stale: number;
  known: number;
  regressions: number;
  recovered: number;
  namespaces: { chain: number; chain_testnet: number };
}

export interface FreshnessReportState {
  startedAt: string;
  phase: FreshnessPhase;
  counts: FreshnessCounts | null;
  notificationAttempted: boolean;
}

export interface FreshnessReport {
  schema_version: 1;
  source_sha: string | null;
  node_version: string;
  started_at: string;
  finished_at: string;
  mode: "check-only" | "notify";
  status: "ok" | "stale" | "error";
  phase: FreshnessPhase;
  counts: FreshnessCounts | null;
  notification: { mode: "suppressed" | "enabled"; attempted: boolean };
  error_code: "check_failed" | null;
}

export function parseFreshnessArgs(argv: readonly string[]): {
  checkOnly: boolean;
  reportPath: string | null;
  valid: boolean;
} {
  let checkOnly = false;
  let reportPath: string | null = null;
  let reportSeen = false;
  let valid = true;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--check-only") {
      if (checkOnly) valid = false;
      checkOnly = true;
    } else if (argv[i] === "--report") {
      if (reportSeen) valid = false;
      reportSeen = true;
      const value = argv[i + 1];
      if (value && value.trim() && !value.startsWith("-")) {
        // Keep the first usable destination for an argument-error report.
        reportPath ??= value;
        i += 1;
      } else {
        valid = false;
      }
    } else {
      valid = false;
    }
  }
  return { checkOnly, reportPath, valid };
}

/** Only control-flow fields and completed counts cross into the artifact. */
export function createFreshnessReport({
  state,
  status,
  checkOnly,
  sourceSha,
  nodeVersion,
  finishedAt,
}: {
  state: FreshnessReportState;
  status: FreshnessReport["status"];
  checkOnly: boolean;
  sourceSha: string | undefined;
  nodeVersion: string;
  finishedAt: string;
}): FreshnessReport {
  const counts = status === "error" ? null : state.counts;
  return {
    schema_version: 1,
    source_sha:
      sourceSha && /^[a-fA-F0-9]{40}$/.test(sourceSha) ? sourceSha : null,
    node_version: nodeVersion,
    started_at: state.startedAt,
    finished_at: finishedAt,
    mode: checkOnly ? "check-only" : "notify",
    status,
    phase: state.phase,
    counts: counts
      ? {
          tables: counts.tables,
          stale: counts.stale,
          known: counts.known,
          regressions: counts.regressions,
          recovered: counts.recovered,
          namespaces: {
            chain: counts.namespaces.chain,
            chain_testnet: counts.namespaces.chain_testnet,
          },
        }
      : null,
    notification: {
      mode: checkOnly ? "suppressed" : "enabled",
      attempted: state.notificationAttempted,
    },
    error_code: status === "error" ? "check_failed" : null,
  };
}
