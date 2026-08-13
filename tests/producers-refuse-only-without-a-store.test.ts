// The last lanes that hard-refused without a store binding (#10158).
//
// Each of these READS from a table Neon owns, and each answered a refusal
// before it got there -- `d1_binding_missing`, `watermark_unavailable`,
// "refusing to run". The refusals were right when D1 was the store. They became
// a check on a binding the lane no longer uses, and on the day D1 is dropped
// they stop being harmless: every one of these turns into a lane that declines
// forever while the Neon read it would have made sits ready.
//
// Two of them are worse than a decline if they DON'T refuse, which is why the
// refusal is kept rather than deleted:
//
//   raw-capture-sync without a durable watermark cannot know where to resume,
//   and that is exactly how a gap forms.
//
//   surface-verification-sync over zero rows publishes a snapshot that strips
//   machine-verified from the entire registry.
//
// So each lane gets a pair: with Neon owning its tables it must get past the
// refusal, and with nothing bound at all it must still refuse.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { refreshLiveEconomics } from "../src/live-economics-refresh.ts";
import { runSurfaceVerificationSync } from "../src/surface-verification-sync.ts";

const HYPERDRIVE = { connectionString: "postgresql://example/db" };

/** The refusal each lane gives when it has nowhere to read from. */
const LANES: {
  name: string;
  tables: string[];
  refusal: string;
  run: (env: Record<string, unknown>) => Promise<{ reason?: string }>;
}[] = [
  {
    name: "live-economics-refresh",
    tables: ["neurons", "subnet_snapshots"],
    refusal: "store_unavailable",
    run: (env) =>
      refreshLiveEconomics(env as never, {
        // A reader that answers, so the decline under test is the STORE one and
        // not the artifact one that runs before it.
        readArtifact: (async () => ({
          subnets: [{ netuid: 1 }],
        })) as never,
      }) as Promise<{ reason?: string }>,
  },
  {
    name: "surface-verification-sync",
    tables: ["surface_uptime_daily", "surface_checks"],
    refusal: "store_unavailable",
    run: (env) =>
      runSurfaceVerificationSync(env as never) as Promise<{ reason?: string }>,
  },
];

describe("with Neon owning its tables and no D1 bound", () => {
  for (const { name, refusal, run } of LANES) {
    test(`${name} gets past its store check`, async () => {
      const result = await run({
        HYPERDRIVE,
        METAGRAPH_CONTROL: {
          put: async () => undefined,
          get: async () => null,
        },
      });
      assert.notEqual(
        result.reason,
        refusal,
        `${name} refused over a binding it no longer reads through`,
      );
    });
  }
});

describe("with nothing bound at all", () => {
  for (const { name, refusal, run } of LANES) {
    test(`${name} still refuses`, async () => {
      // Without this the assertions above would also pass against a lane whose
      // store check was simply deleted -- and for these two lanes running with
      // no store is worse than not running: see this file's header.
      const result = await run({
        METAGRAPH_CONTROL: {
          put: async () => undefined,
          get: async () => null,
        },
      });
      assert.equal(result.reason, refusal, name);
    });
  }
});
