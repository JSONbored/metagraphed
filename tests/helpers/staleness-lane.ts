// Reaching one staleness watchdog through the registry that now owns it.
//
// These lanes used to have a cron each, and their tests dispatched through
// `handleScheduled({ cron })` to prove the wiring reached them. Since #10849
// item 5 there is one heartbeat, and dispatching through it would run all eight
// siblings against an env fixture built for one -- harmless, because the
// heartbeat isolates every lane, but it would add the siblings' queries to the
// `queries` arrays these tests assert on.
//
// So the per-lane tests exercise the REGISTRY ENTRY, which is the part specific
// to them, and tests/staleness-watchdog-registry.test.ts covers the part that is
// shared: that the heartbeat cron is declared, unique, handled, and actually
// runs the registry.
import { STALENESS_WATCHDOGS } from "../../workers/api.ts";

/** The registered lane, or a failure naming what is missing. */
export function stalenessLane(name: string) {
  const lane = STALENESS_WATCHDOGS.find((entry) => entry.name === name);
  if (!lane) {
    throw new Error(
      `no staleness watchdog registered as "${name}" -- registered: ` +
        STALENESS_WATCHDOGS.map((entry) => entry.name).join(", "),
    );
  }
  return lane;
}

/** Run one registered lane the way the heartbeat runs it. */
export async function runStalenessLane(
  name: string,
  env: unknown,
  ctx?: unknown,
): Promise<Record<string, unknown>> {
  return stalenessLane(name).run({ env, ctx } as never);
}
