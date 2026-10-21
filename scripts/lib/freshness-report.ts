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
  schema_version: 2;
  source_sha: string | null;
  node_version: string;
  started_at: string;
  finished_at: string;
  mode: "check-only" | "notify";
  status: "ok" | "stale" | "error";
  phase: FreshnessPhase;
  counts: FreshnessCounts | null;
  notification: { mode: "suppressed" | "enabled"; attempted: boolean };
  error_code:
    | "check_failed"
    | "invalid_arguments"
    | "d1_credentials"
    | "d1_transport"
    | "d1_http"
    | "d1_response"
    | "catalog_inventory"
    | "catalog_metadata"
    | null;
  http_status: number | null;
  cloudflare_code: 10000 | null;
}

/** Exact internal messages only; never serialize an exception or provider text. */
function failureDiagnostic(
  error: unknown,
): Pick<FreshnessReport, "error_code" | "http_status" | "cloudflare_code"> {
  let code: FreshnessReport["error_code"] = "check_failed";
  try {
    if (error instanceof Error) {
      const message = error.message;
      if (typeof message !== "string" || message.length > 256)
        return { error_code: code, http_status: null, cloudflare_code: null };
      const http =
        /^D1 maintenance request failed with HTTP (\d{3})(; Cloudflare error codes: 10000)?$/.exec(
          message,
        );
      if (
        http &&
        http[0] === message &&
        [
          204, 400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504,
        ].includes(Number(http[1]))
      )
        return {
          error_code: "d1_http",
          http_status: Number(http[1]),
          cloudflare_code: http[2] ? 10000 : null,
        };
      switch (message) {
        case "Invalid lakehouse freshness arguments":
          code = "invalid_arguments";
          break;
        case "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID and CLOUDFLARE_API_TOKEN are required for D1 maintenance":
          code = "d1_credentials";
          break;
        case "D1 maintenance request failed; verify state before retrying a write":
          code = "d1_transport";
          break;
        case "D1 maintenance response exceeds 4 MiB":
        case "D1 maintenance response is not valid JSON":
        case "D1 maintenance batch failed or returned an invalid result":
          code = "d1_response";
          break;
        case "Catalog metadata inventory is empty or exceeds its bound":
        case "Catalog metadata inventory repeats a table":
        case "Catalog table inventory is unavailable: chain":
        case "Catalog table inventory is unavailable: chain_testnet":
          code = "catalog_inventory";
          break;
        case "Catalog metadata row is invalid":
        case "Catalog metadata summary is invalid JSON":
        case "Catalog schema or freshness metadata is incomplete":
          code = "catalog_metadata";
      }
    }
  } catch {
    // Even a hostile error object's accessors must not prevent the safe report.
  }
  return { error_code: code, http_status: null, cloudflare_code: null };
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

/** Only control flow, completed counts and allowlisted diagnostics are retained. */
export function createFreshnessReport({
  state,
  status,
  checkOnly,
  sourceSha,
  nodeVersion,
  finishedAt,
  error,
}: {
  state: FreshnessReportState;
  status: FreshnessReport["status"];
  checkOnly: boolean;
  sourceSha: string | undefined;
  nodeVersion: string;
  finishedAt: string;
  error?: unknown;
}): FreshnessReport {
  const counts = status === "error" ? null : state.counts;
  return {
    schema_version: 2,
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
    ...(status === "error"
      ? failureDiagnostic(error)
      : { error_code: null, http_status: null, cloudflare_code: null }),
  };
}
