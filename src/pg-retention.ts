import type { NativeSource } from "./native-api-process.ts";
import {
  NEON_PRUNE_PLANS,
  MIN_RETENTION_MS,
  type PruneTableOutcome,
} from "./neon-prune.ts";
import type { NativeRetentionStore } from "./native-retention-store.ts";
import { assertIdentifier } from "./neon-write.ts";

/** A complete rolling-window owner; no timer, migration or pool lifecycle. */
export function createPgRetentionStore(
  source: Pick<NativeSource, "schema" | "relations" | "access" | "transaction">,
): NativeRetentionStore {
  const plans = Object.values(NEON_PRUNE_PLANS).map((plan) =>
    Object.freeze({ ...plan }),
  );
  if (
    source.schema !== "app" ||
    source.access !== "read-write" ||
    plans.some((plan) => !source.relations.includes(plan.table))
  )
    throw new Error(
      "Native retention requires complete writable app ownership",
    );
  for (const plan of plans) {
    assertIdentifier(plan.table, "retention table");
    assertIdentifier(plan.column, "retention column");
    if (
      !Number.isSafeInteger(plan.retentionMs) ||
      plan.retentionMs < MIN_RETENTION_MS
    )
      throw new RangeError("Native retention policy is below its safe floor");
  }
  const transaction = source.transaction.bind(source);
  return {
    async prune(nowMs) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0)
        throw new RangeError("Native retention timestamp is invalid");
      const outcomes: PruneTableOutcome[] = [];
      for (const plan of plans) {
        let deleting = false;
        const base = { table: plan.table, deleted: 0 };
        try {
          outcomes.push(
            await transaction(
              async (scope) => {
                const cutoff = nowMs - plan.retentionMs;
                // Hold writers until the impact check and delete agree on one
                // table state. A concurrent deletion cannot remove the last
                // survivor between the guard and the destructive statement.
                await scope.run(
                  `LOCK TABLE app.${plan.table} IN SHARE ROW EXCLUSIVE MODE`,
                );
                const impact = await scope.first<{
                  doomed: string | number;
                  survivors: string | number;
                }>(
                  `SELECT COUNT(*) FILTER (WHERE ${plan.column}<$1) AS doomed,
              COUNT(*) FILTER (WHERE ${plan.column}>=$1) AS survivors FROM app.${plan.table}`,
                  [cutoff],
                );
                const doomed = Number(impact?.doomed),
                  survivors = Number(impact?.survivors);
                if (
                  !impact ||
                  !Number.isSafeInteger(doomed) ||
                  doomed < 0 ||
                  !Number.isSafeInteger(survivors) ||
                  survivors < 0
                )
                  return { ...base, skipped: "impact unreadable" };
                if (doomed === 0) return base;
                if (survivors === 0)
                  return {
                    ...base,
                    skipped: `refused: every one of ${doomed} row(s) is older than the cutoff`,
                  };
                deleting = true;
                const result = await scope.run(
                  `DELETE FROM app.${plan.table} WHERE ${plan.column}<$1`,
                  [cutoff],
                );
                if (!Number.isSafeInteger(result.changes) || result.changes < 0)
                  throw new Error("Invalid native retention deletion receipt");
                return { table: plan.table, deleted: result.changes };
              },
              { isolation: "read committed" },
            ),
          );
        } catch (error) {
          outcomes.push({
            ...base,
            skipped: deleting
              ? `delete not acknowledged: ${error instanceof Error ? error.message : String(error)}`
              : "impact unreadable",
          });
        }
      }
      return outcomes;
    },
  };
}
