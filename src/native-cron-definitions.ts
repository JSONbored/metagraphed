import { API_HANDLED_CRONS } from "../workers/api.ts";
import { DATA_API_CRON_LANES } from "../workers/data-api.ts";
import { SELF_HEALTH_PROBE_CRON } from "../workers/config.ts";
import type { NativeCronDefinition } from "./pg-cron.ts";

/** Uses the same exact strings as each existing Worker dispatcher. */
export const NATIVE_CRON_DEFINITIONS: readonly NativeCronDefinition[] = [
  ...API_HANDLED_CRONS.map((cron) => ({ owner: "api" as const, cron })),
  ...Object.keys(DATA_API_CRON_LANES).map((cron) => ({
    owner: "data" as const,
    cron,
  })),
  { owner: "registry", cron: SELF_HEALTH_PROBE_CRON },
];
