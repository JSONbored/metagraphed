import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, test } from "vitest";
import { chunkRows, MAX_ROWS_PER_REQUEST } from "../scripts/sync-neurons.ts";
import type { Row } from "./row-type.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function row(uid: number, extra: Row = {}): Row {
  return {
    netuid: 1,
    uid,
    hotkey: `5${"H".repeat(46)}`,
    coldkey: `5${"C".repeat(46)}`,
    stake_tao: 1.5,
    captured_at: 1_785_700_000,
    ...extra,
  };
}

describe("chunkRows", () => {
  test("a snapshot under both caps is a single request", () => {
    const chunks = chunkRows([row(0), row(1), row(2)]);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 3);
  });

  test("every row is emitted exactly once, in order", () => {
    const rows = Array.from({ length: MAX_ROWS_PER_REQUEST * 2 + 7 }, (_, i) =>
      row(i),
    );
    const chunks = chunkRows(rows);
    const flattened = chunks.flat();
    assert.equal(
      flattened.length,
      rows.length,
      "no rows dropped or duplicated",
    );
    assert.deepEqual(
      flattened.map((r) => r.uid),
      rows.map((r) => r.uid),
      "order preserved across the chunk boundary",
    );
  });

  test("splits on the row-count cap", () => {
    const rows = Array.from({ length: MAX_ROWS_PER_REQUEST + 1 }, (_, i) =>
      row(i),
    );
    const chunks = chunkRows(rows);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, MAX_ROWS_PER_REQUEST);
    assert.equal(chunks[1].length, 1);
  });

  // The cap that actually bites first on a wide snapshot: the route measures
  // the encoded body, so row COUNT alone is not a sufficient guard.
  test("splits on the byte cap even when the row count is small", () => {
    const fat = row(0, { axon: "x".repeat(2_000_000) });
    const chunks = chunkRows([
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
      fat,
    ]);
    assert.ok(
      chunks.length > 1,
      "13 x ~2MB rows must not be sent as one 26MB body",
    );
    for (const chunk of chunks) {
      const bytes = new TextEncoder().encode(JSON.stringify(chunk)).length;
      assert.ok(
        bytes < 32_000_000,
        `chunk of ${bytes} bytes must stay under the route's 32MB cap`,
      );
    }
  });

  test("a single row larger than the cap is still emitted, not silently dropped", () => {
    // Better to let the route reject one oversized row with a 413 than to
    // drop it here and report a successful sync that lost data.
    const huge = row(0, { axon: "x".repeat(25_000_000) });
    const chunks = chunkRows([huge]);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 1);
  });

  test("an empty snapshot yields no requests", () => {
    assert.deepEqual(chunkRows([]), []);
  });
});

// End-to-end proof that the observability wiring actually reports, run as a
// real subprocess against a stand-in PostHog ingest endpoint.
//
// Asserting the import, or that the workflow sets the var, would not have
// caught the bug this replaces: initObservability() returns early without
// POSTHOG_PROJECT_TOKEN, so a script can import the helper, call it, and still
// report nothing. The only convincing evidence is an exception arriving over
// the wire -- so that is what is asserted.
//
// spawn(), not execFileSync(): the sink has to answer the request while the
// child runs, and execFileSync would block this process's event loop and
// deadlock against its own server.
describe("failure reporting (#9505)", () => {
  function startSink() {
    const events: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        let text: string;
        try {
          // posthog-node gzips its batch payloads.
          text = gunzipSync(raw).toString("utf8");
        } catch {
          text = raw.toString("utf8");
        }
        try {
          const body = JSON.parse(text) as {
            batch?: Record<string, unknown>[];
          };
          events.push(...(body.batch ?? []));
        } catch {
          /* a body we cannot parse is simply not an event */
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: 1 }));
      });
    });
    return new Promise<{
      port: number;
      events: Record<string, unknown>[];
      close: () => Promise<void>;
    }>((resolve) => {
      server.listen(0, "127.0.0.1", () =>
        resolve({
          port: (server.address() as { port: number }).port,
          events,
          close: () => new Promise<void>((done) => server.close(() => done())),
        }),
      );
    });
  }

  /** Run sync-neurons.ts with no NEURONS_SYNC_SECRET, which fails immediately. */
  function runFailing(env: Record<string, string>) {
    return new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ["scripts/sync-neurons.ts"], {
        cwd: repoRoot,
        stdio: "ignore",
        env: {
          ...process.env,
          NEURONS_SYNC_SECRET: "",
          POSTHOG_PROJECT_TOKEN: "",
          ...env,
        },
      });
      child.on("close", (code) => resolve(code));
    });
  }

  test("a failed sync sends a $exception tagged with the component, and still exits non-zero", async () => {
    const sink = await startSink();
    const code = await runFailing({
      POSTHOG_PROJECT_TOKEN: "phc_test_token",
      POSTHOG_HOST: `http://127.0.0.1:${sink.port}`,
    });
    await sink.close();

    assert.equal(code, 1, "a failed sync must still fail the workflow step");
    const exceptions = sink.events.filter(
      (event) => event.event === "$exception",
    );
    assert.equal(exceptions.length, 1, "expected exactly one exception event");
    const properties = exceptions[0].properties as Record<string, unknown>;
    assert.equal(exceptions[0].distinct_id, "metagraphed-infra");
    assert.equal(
      properties.component,
      "sync-neurons",
      "the event must say which script produced it",
    );
    const detail = (
      properties.$exception_list as { type: string; value: string }[]
    )[0];
    assert.equal(detail.type, "Error");
    assert.match(detail.value, /NEURONS_SYNC_SECRET is required/);
  });

  // The pre-fix production state. Exit status must be identical either way --
  // the reporting is additive, and a box/local run without a token must not
  // start behaving differently from one with it.
  test("without the token it reports nothing and the exit status is unchanged", async () => {
    const sink = await startSink();
    const code = await runFailing({
      POSTHOG_HOST: `http://127.0.0.1:${sink.port}`,
    });
    await sink.close();

    assert.equal(code, 1);
    assert.deepEqual(sink.events, []);
  });
});
