import { migrationSequenceErrors } from "../validate-migrations.ts";

const LEDGER_FAILURES = new Set([
  "tracked_invalid",
  "response_unavailable",
  "record_invalid",
  "ledger_mismatch",
] as const);
type LedgerFailure =
  | "tracked_invalid"
  | "response_unavailable"
  | "record_invalid"
  | "ledger_mismatch";

export class D1MigrationLedgerError extends Error {
  readonly reason: LedgerFailure;
  constructor(reason: LedgerFailure, message: string) {
    super(message);
    this.name = "D1MigrationLedgerError";
    this.reason = reason;
  }
}

export function assertTrackedD1Migrations(files: readonly string[]): void {
  if (!files.length || migrationSequenceErrors(files).length)
    throw new D1MigrationLedgerError(
      "tracked_invalid",
      "Tracked D1 migrations are empty or invalid",
    );
}

export function assertRecordedD1Migrations(
  files: readonly string[],
  rows: readonly Record<string, unknown>[] | undefined,
): void {
  if (!rows)
    throw new D1MigrationLedgerError(
      "response_unavailable",
      "D1 migration ledger response is unavailable",
    );
  const names = rows.map((row) => row.name);
  if (
    names.some((name) => typeof name !== "string") ||
    migrationSequenceErrors(names as string[]).length
  )
    throw new D1MigrationLedgerError(
      "record_invalid",
      "D1 migration ledger contains invalid or duplicate names",
    );
  const recorded = new Set(names);
  const tracked = new Set(files);
  const missing = files.filter((file) => !recorded.has(file));
  const extra = names.filter((name) => !tracked.has(name as string));
  if (missing.length || extra.length)
    throw new D1MigrationLedgerError(
      "ledger_mismatch",
      `D1 migration ledger differs: ${missing.length} missing, ${extra.length} untracked. Verification did not apply migrations.`,
    );
}

/** Fixed classifications only: never log provider text, SQL or credentials. */
export function d1SchemaVerificationFailure(error: unknown): string {
  if (
    error instanceof D1MigrationLedgerError &&
    LEDGER_FAILURES.has(error.reason)
  )
    return `D1 migration ledger verification failed (${error.reason})`;
  if (error instanceof Error) {
    const http =
      /^D1 maintenance request failed with HTTP ([1-5]\d{2})(?:;|$)/.exec(
        error.message,
      );
    if (http) {
      const code =
        error.message ===
        `D1 maintenance request failed with HTTP ${http[1]}; Cloudflare error codes: 10000`
          ? "; Cloudflare error codes: 10000"
          : "";
      return `D1 schema verification failed (http_${http[1]})${code}`;
    }
  }
  return "D1 schema verification failed (unclassified)";
}
