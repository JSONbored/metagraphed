import { captureTick } from "../../src/raw-chain-capture.ts";
import { rawCaptureD1 } from "../../src/raw-capture-d1.ts";
import { neonWatermark } from "../../src/raw-capture-sync.ts";
import { RAW_CAPTURE_GENESIS_FLOOR } from "../../src/raw-capture-floors.ts";

(globalThis as Record<string, unknown>).__metagraphed_resource_target = true;

type Env = {
  D1_STATE: D1Database;
  RESOURCE_RPC_URL: string;
};

/** Intercept only an explicitly controlled second-window fixture failure.
 * Every non-faulted statement and every transaction reaches the native binding. */
function faultableDatabase(db: D1Database, fault: Error | null) {
  const originals = new WeakMap<object, D1PreparedStatement>();
  let hits = 0;
  function wrap(
    sql: string,
    statement: D1PreparedStatement,
    values: unknown[],
  ) {
    const wrapped = {
      bind(...bound: unknown[]) {
        return wrap(sql, statement.bind(...bound), bound);
      },
      first<T>(column?: string) {
        return column === undefined
          ? statement.first<T>()
          : statement.first<T>(column);
      },
      all<T>() {
        return statement.all<T>();
      },
      run<T>() {
        if (
          fault &&
          sql.startsWith("INSERT INTO raw_capture_chunks(") &&
          values[2] === 8
        ) {
          hits++;
          throw fault;
        }
        return statement.run<T>();
      },
    };
    originals.set(wrapped, statement);
    return wrapped;
  }
  return {
    get hits() {
      return hits;
    },
    db: {
      prepare(sql: string) {
        return wrap(sql, db.prepare(sql), []);
      },
      batch(statements: object[]) {
        return db.batch(
          statements.map((statement) => {
            const original = originals.get(statement);
            if (!original) throw new Error("fixture_statement_identity");
            return original;
          }),
        );
      },
    } as Pick<D1Database, "prepare" | "batch">,
  };
}

export default {
  async fetch(request: Request, env: Env, _ctx: unknown) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/__resource/warm") {
      // Load the same lazy API module as the production scheduled entry before
      // the capture baseline; never import it eagerly from this controller.
      const api = (await import("../../workers/api.ts")).default;
      if (
        typeof api.fetch !== "function" ||
        typeof api.scheduled !== "function" ||
        typeof api.queue !== "function"
      )
        throw new Error("fixture_api_shape");
      (
        globalThis as Record<string, unknown>
      ).__metagraphed_resource_api_warmed = true;
      return Response.json({ ready: true });
    }
    if (
      pathname !== "/__resource/capture" ||
      (globalThis as Record<string, unknown>)
        .__metagraphed_resource_api_warmed !== true
    )
      return Response.json(
        { failureClass: "fixture_route_or_warmup" },
        { status: 400 },
      );
    const body = (await request.json()) as {
      at?: unknown;
      failSecondWindow?: unknown;
    };
    if (
      request.method !== "POST" ||
      Object.keys(body).sort().join(",") !== "at,failSecondWindow" ||
      ![1_790_090_000_000, 1_790_090_001_000, 1_790_090_002_000].includes(
        body.at as number,
      ) ||
      typeof body.failSecondWindow !== "boolean"
    )
      return Response.json(
        { failureClass: "fixture_control_invalid" },
        { status: 400 },
      );
    const fault = body.failSecondWindow
      ? new Error("fixture_second_window")
      : null;
    const adapter = faultableDatabase(env.D1_STATE, fault);
    const now = () => body.at as number;
    try {
      // Recreate the actual writer and watermark facade on every invocation.
      // The producer's parsed records remain live naturally through its flush.
      const result = await captureTick({
        rpcUrls: [env.RESOURCE_RPC_URL],
        requireEvents: true,
        store: rawCaptureD1(adapter.db),
        watermark: neonWatermark(
          { D1_STATE: env.D1_STATE, D1_STATE_TABLES: "raw_capture_state" },
          undefined,
          "mainnet",
          now,
        ),
        genesisFloor: RAW_CAPTURE_GENESIS_FLOOR,
        maxPerTick: 25,
        network: "mainnet",
        flushEvery: 25,
        fetchImpl: fetch,
        now,
      });
      if (result.stoppedAt !== undefined || result.reason !== undefined)
        return Response.json(
          { failureClass: "capture_stopped", faultHits: adapter.hits },
          { status: 500 },
        );
      return Response.json({
        captured: result.captured,
        watermark: result.watermark,
        behind: result.behind,
        faultHits: adapter.hits,
      });
    } catch (error) {
      return Response.json(
        {
          failureClass:
            error === fault ? "injected_second_window" : "capture_failed",
          faultHits: adapter.hits,
        },
        { status: 500 },
      );
    }
  },
};
