import { beforeEach, expect, it, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);
vi.mock("../src/emission-gate-sampler.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/emission-gate-sampler.ts")>()),
  sampleEmissionGateWithFailover: vi.fn(async () => ({
    block_number: 8_500_000,
    observed_at: Date.parse("2026-08-02T12:00:00Z"),
    current: {
      emission_gate_bar: 0.42,
      emission_bar_quantile: 0.75,
      emission_gate_exponent: null,
      block_emission_halvings: 2,
    },
    current_enabled: [[1, true]],
    flow_observations: [
      { item: "net_tao_flow_enabled", raw: null },
      { item: "flow_norm_exponent", raw: null },
      { item: "tao_flow_cutoff", raw: null },
      { item: "flow_ema_smoothing_factor", raw: null },
    ],
    current_ema: [[1, null]],
  })),
}));

import { handleScheduled } from "../workers/api.ts";
import { EMISSION_GATE_SAMPLE_CRON } from "../workers/config.ts";

beforeEach(() => {
  pg.control.queries.length = 0;
  pg.control.connects = 0;
  pg.control.ends = 0;
  pg.control.failNext = null;
  pg.control.rows = [];
});

// Execute the real scheduled dispatcher, sync handler and producer owner. Only
// the sampler and pg driver are doubled; no RPC or database service is used.
it.each(["success", "connect failure", "query failure"] as const)(
  "parks the producer's teardown after scheduled emission %s",
  async (outcome) => {
    let finishEnd!: () => void;
    const ending = new Promise<void>((resolve) => {
      finishEnd = resolve;
    });
    const pending: Promise<unknown>[] = [];
    const connect = vi.spyOn(pg.module.Client.prototype, "connect");
    const originalEnd = pg.module.Client.prototype.end;
    const end = vi
      .spyOn(pg.module.Client.prototype, "end")
      .mockImplementation(function (
        this: InstanceType<typeof pg.module.Client>,
      ) {
        // Cron health reporting can create another Client. Identify the producer
        // by its first connect rather than mistaking that other close for ours.
        if (this === connect.mock.contexts[0]) return ending;
        return originalEnd.call(this);
      });
    if (outcome === "connect failure")
      connect.mockRejectedValueOnce(new Error("synthetic connect failure"));
    if (outcome === "query failure")
      pg.control.failNext = new Error("synthetic query failure");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await handleScheduled(
        { cron: EMISSION_GATE_SAMPLE_CRON } as ScheduledController,
        {
          ...pgMockEnv(),
          EMISSION_GATE_SYNC_SECRET: "synthetic-test-value",
        } as unknown as Env,
        {
          waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        } as unknown as ExecutionContext,
      );
      expect(result).toMatchObject({
        ok: outcome === "success",
        status: outcome === "success" ? 200 : 502,
      });
      const producer = connect.mock.contexts[0];
      expect(producer).toBeDefined();
      expect(
        end.mock.contexts.filter((client) => client === producer),
      ).toHaveLength(1);
      expect(pending.length).toBeGreaterThan(0);
      let drained = false;
      const drain = Promise.all(pending).then(() => {
        drained = true;
      });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(drained).toBe(false);
      finishEnd();
      await drain;
      expect(drained).toBe(true);
    } finally {
      finishEnd();
      await Promise.allSettled(pending);
      connect.mockRestore();
      end.mockRestore();
      errors.mockRestore();
    }
  },
);
