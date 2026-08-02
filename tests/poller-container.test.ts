import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { ensurePollerRunning } from "../workers/poller-container-control.ts";
import { mockEnv } from "./row-type.ts";
import type { Row } from "./row-type.ts";

// A namespace whose stub records how it was reached, so the singleton claim
// is asserted rather than assumed.
function nsStub(opts: Row = {}) {
  const calls: { name: string; started: number } = { name: "", started: 0 };
  return {
    calls,
    ns: {
      idFromName(name: string) {
        calls.name = name;
        return { name };
      },
      get() {
        if (opts.notAContainer) return {};
        return {
          async startAndWaitForPorts() {
            calls.started += 1;
            if (opts.throws) throw new Error("container boot failed");
          },
        };
      },
    },
  };
}

describe("ensurePollerRunning", () => {
  test("starts the singleton instance", async () => {
    const { ns, calls } = nsStub();
    const env = mockEnv({ POLLER_CONTAINER: ns }) as unknown as Env;
    const outcome = await ensurePollerRunning(env);
    assert.deepEqual(outcome, { ok: true, detail: "running" });
    assert.equal(calls.started, 1);
  });

  // A second instance would run the same interval loops against the same sync
  // routes, and the neurons route's per-netuid prune keys on captured_at — an
  // older instance's snapshot landing after a newer one's would delete UIDs
  // the newer one just wrote. The fixed name is what prevents that.
  test("always addresses the same instance name", async () => {
    const { ns, calls } = nsStub();
    const env = mockEnv({ POLLER_CONTAINER: ns }) as unknown as Env;
    await ensurePollerRunning(env);
    assert.equal(calls.name, "global");
  });

  test("an unbound namespace is reported, not thrown", async () => {
    const env = mockEnv({ POLLER_CONTAINER: undefined }) as unknown as Env;
    const outcome = await ensurePollerRunning(env);
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /not bound/);
  });

  // Guards the structural cast: if the binding ever resolves to a plain
  // Durable Object rather than a Container, say so instead of throwing a
  // TypeError inside a cron.
  test("a stub without the Container method is reported, not thrown", async () => {
    const { ns } = nsStub({ notAContainer: true });
    const env = mockEnv({ POLLER_CONTAINER: ns }) as unknown as Env;
    const outcome = await ensurePollerRunning(env);
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /not a Container/);
  });

  // A cron runs several lanes in one handler; one failing ping must not stop
  // the others.
  test("a boot failure is captured, not propagated", async () => {
    const { ns } = nsStub({ throws: true });
    const env = mockEnv({ POLLER_CONTAINER: ns }) as unknown as Env;
    const outcome = await ensurePollerRunning(env);
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /container boot failed/);
  });
});
