import {
  classifyLaneHealthWriteError,
  classifyLaneHealthWriteReason,
  type LaneHealthWriteFailure,
} from "./lane-health-write-diagnostics.ts";
import type { FamilyMirrorOutcome } from "./hyperparams-identity-neon-write.ts";

type Failure =
  | { stage: "history_read"; error: unknown }
  | { stage: "family_write"; outcome: FamilyMirrorOutcome }
  | { stage: "upstream_response"; status: number };
type Summary = {
  stage: Failure["stage"];
  reasons: (LaneHealthWriteFailure | "unreadable_response")[];
  upstream_status: number | null;
  confirmed_rows: null;
};

/** One failure per minute per isolate. Classes describe observed failures,
 * never commit state. No packet, account, exception text or header is emitted. */
export function createAccountIdentitySyncReporter(
  now: () => number = () => Date.now(),
  emit: (summary: Summary) => void = (summary) =>
    console.warn("account_identity_sync_failure", summary),
) {
  let nextReportAt = 0;
  const report = (failure: Failure): void => {
    const time = now();
    if (time < nextReportAt) return;
    nextReportAt = time + 60_000;
    try {
      let reasons: Summary["reasons"];
      if (failure.stage === "history_read") {
        reasons = [classifyLaneHealthWriteError(failure.error)];
      } else if (failure.stage === "family_write") {
        reasons = failure.outcome.attempted
          ? ["account_identity", "account_identity_history"].flatMap(
              (table) => {
                const result = failure.outcome.results[table];
                return result && !result.ok
                  ? [classifyLaneHealthWriteReason(result.reason)]
                  : [];
              },
            )
          : ["missing_store"];
      } else {
        reasons = ["unreadable_response"];
      }
      emit({
        stage: failure.stage,
        reasons,
        upstream_status:
          failure.stage === "upstream_response" ? failure.status : null,
        confirmed_rows: null,
      });
    } catch {
      // Best-effort diagnostics cannot change status or retry a write.
    }
  };
  return Object.assign(report, {
    reset: () => {
      nextReportAt = 0;
    },
  });
}
