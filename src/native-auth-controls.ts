import { createPgKv, type PgKvRuntime } from "./pg-kv.ts";
import { createPgDailyQuota } from "./pg-daily-quota.ts";
import {
  createPgRateLimits,
  type NativeRateLimitDefinition,
} from "./pg-rate-limits.ts";

/** One explicit process-owned set of authentication controls. Final native
 * assembly must call assertEnvironment after composing its environment, before
 * admitting requests. This does not change Worker defaults or close the pool. */
export function createNativeAuthControls(
  runtime: PgKvRuntime,
  definitions: readonly NativeRateLimitDefinition[],
  onError: (error: unknown, binding: string) => void,
) {
  if (
    definitions.some((definition) =>
      ["CONTROL_KV_STORE", "DAILY_QUOTA_STORE"].includes(definition.binding),
    )
  ) {
    throw new TypeError(
      "Rate binding collides with native authentication storage",
    );
  }
  const rates = createPgRateLimits(runtime, definitions, onError);
  const bindings = Object.freeze({
    ...rates.bindings,
    CONTROL_KV_STORE: createPgKv(runtime, "control"),
    DAILY_QUOTA_STORE: createPgDailyQuota(runtime),
  });
  return {
    bindings,
    pruneExpiredRates: rates.pruneExpired,
    assertEnvironment(env: unknown): void {
      if (!env || typeof env !== "object")
        throw new TypeError("Native authentication environment is missing");
      const selected = env as Record<string, unknown>;
      for (const [name, value] of Object.entries(bindings)) {
        if (selected[name] !== value)
          throw new TypeError(`Native authentication binding differs: ${name}`);
      }
    },
  };
}
