// Unit tests for workers/hyperdrive-sync-retry.ts (METAGRAPHED-7, second recurrence) --
// the sync routes' shared fresh-client transaction retry. The route-level suites
// (data-api, registry-sync-api) prove the wiring; this file pins the helper's own
// branch behavior: fresh client per attempt, the retryable-code scoping, the attempt
// cap, and the non-Error rejection arm no route mock produces.
import { beforeEach, expect, test, vi } from "vitest";

// Each postgres() call returns a client whose begin() consumes the next planned
// outcome -- so "attempts" and "clients constructed" can be asserted independently.
const plan = vi.hoisted(() => ({
  outcomes: [] as Array<{ reject?: unknown; resolve?: unknown }>,
  clientsConstructed: 0,
}));

vi.mock("postgres", () => ({
  default: () => {
    plan.clientsConstructed += 1;
    return {
      begin: (cb: unknown) => {
        const next = plan.outcomes.shift();
        if (!next) throw new Error("test plan exhausted");
        if ("reject" in next) return Promise.reject(next.reject);
        void cb;
        return Promise.resolve(next.resolve);
      },
    };
  },
}));

const { syncBeginWithConnectionRetry, MAX_CONNECTION_RETRY_ATTEMPTS } =
  await import("../workers/hyperdrive-sync-retry.ts");

const env = { HYPERDRIVE: { connectionString: "postgres://mock" } };
const connErr = (code: string) =>
  Object.assign(new Error(`write ${code} mock.hyperdrive.local:5432`), {
    code,
  });

beforeEach(() => {
  plan.outcomes = [];
  plan.clientsConstructed = 0;
});

test("first attempt succeeding uses exactly one client", async () => {
  plan.outcomes = [{ resolve: "ok" }];
  await expect(
    syncBeginWithConnectionRetry(env, async () => "ok"),
  ).resolves.toBe("ok");
  expect(plan.clientsConstructed).toBe(1);
});

test("a retryable connection error gets a FRESH client on retry", async () => {
  plan.outcomes = [{ reject: connErr("CONNECTION_CLOSED") }, { resolve: "ok" }];
  await expect(
    syncBeginWithConnectionRetry(env, async () => "ok"),
  ).resolves.toBe("ok");
  // The retry constructed a second client -- the dead socket lives in the first
  // client's pool, so reusing it would hand the retry the same corpse.
  expect(plan.clientsConstructed).toBe(2);
});

test("every retryable code retries; the cap still bounds total attempts", async () => {
  plan.outcomes = [
    { reject: connErr("CONNECTION_DESTROYED") },
    { reject: connErr("CONNECT_TIMEOUT") },
    { reject: connErr("CONNECTION_CLOSED") },
  ];
  await expect(
    syncBeginWithConnectionRetry(env, async () => "ok"),
  ).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
  // 1 original + MAX_CONNECTION_RETRY_ATTEMPTS retries, then the last error surfaces.
  expect(plan.clientsConstructed).toBe(1 + MAX_CONNECTION_RETRY_ATTEMPTS);
});

test("a non-connection error is never retried", async () => {
  plan.outcomes = [{ reject: connErr("23505") }];
  await expect(
    syncBeginWithConnectionRetry(env, async () => "ok"),
  ).rejects.toMatchObject({ code: "23505" });
  expect(plan.clientsConstructed).toBe(1);
});

test("a non-object rejection (no .code to read) surfaces immediately", async () => {
  plan.outcomes = [{ reject: null }];
  await expect(
    syncBeginWithConnectionRetry(env, async () => "ok"),
  ).rejects.toBeNull();
  expect(plan.clientsConstructed).toBe(1);
});
