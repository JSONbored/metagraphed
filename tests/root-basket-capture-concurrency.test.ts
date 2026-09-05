import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  test,
  vi,
} from "vitest";
import { createProducerStore } from "../src/producer-store.ts";
import {
  rootBasketCaptureDigest,
  writeRootBasketCapture,
} from "../src/root-basket-capture-write.ts";
import { RootBasketCaptureSchema } from "../schemas-src/root-basket-capture.ts";
import { syntheticBasketCapture } from "./fixtures/root-basket-capture.ts";

// PGlite exercises constraints and rollback in the companion suite but has one
// connection. These real lock races use an ephemeral Unix-socket-only cluster:
// no configured database, remote connection, persistent data or TCP listener.
// Run with PostgreSQL server tools installed as a non-root user. Other hosts
// explicitly skip these cases, while the portable PGlite suite always runs.
const bindir = spawnSync("pg_config", ["--bindir"], {
  encoding: "utf8",
}).stdout?.trim();
const available =
  !!bindir &&
  existsSync(path.join(bindir, "initdb")) &&
  existsSync(path.join(bindir, "pg_ctl")) &&
  process.getuid?.() !== 0;
let directory: string;
let admin: Client;
const clients = new Set<Client>();
const barriers = new Set<() => void>();

function client(name: string) {
  const connection = new Client({
    host: directory,
    user: "capture_test",
    database: "postgres",
    application_name: name,
    // A server-side bound actually cancels blocked SQL; a client-side promise
    // timeout could leave the transaction blocking the next test's TRUNCATE.
    statement_timeout: 5_000,
  });
  clients.add(connection);
  return connection;
}

async function closeClients() {
  for (const release of barriers) release();
  barriers.clear();
  const pending = [...clients];
  clients.clear();
  // end() disconnects an active pg query and rolls back its transaction. Never
  // enqueue ROLLBACK behind a blocked query or await the blocked client first.
  const results = await Promise.allSettled(
    pending.map((connection) => connection.end()),
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length) throw new AggregateError(errors, "closing race clients");
}

describe.skipIf(!available)(
  "capture publication with concurrent PostgreSQL connections",
  () => {
    beforeAll(async () => {
      directory = mkdtempSync(path.join(tmpdir(), "basket-race-"));
      execFileSync(
        path.join(bindir!, "initdb"),
        [
          "-D",
          path.join(directory, "data"),
          "-U",
          "capture_test",
          "-A",
          "trust",
          "--no-locale",
        ],
        { stdio: "ignore" },
      );
      execFileSync(
        path.join(bindir!, "pg_ctl"),
        [
          "-D",
          path.join(directory, "data"),
          "-l",
          path.join(directory, "server.log"),
          "-o",
          `-c listen_addresses='' -c unix_socket_directories='${directory}'`,
          "-w",
          "start",
        ],
        { stdio: "ignore" },
      );
      admin = new Client({
        host: directory,
        user: "capture_test",
        database: "postgres",
        application_name: "observer",
        statement_timeout: 5_000,
      });
      await admin.connect();
      for (const file of [
        "0036_root_basket_observations.sql",
        "0037_root_basket_capture_completion.sql",
      ])
        await admin.query(readFileSync(`migrations/neon/${file}`, "utf8"));
    }, 30_000);
    beforeEach(async () => {
      await admin.query("TRUNCATE root_basket_captures CASCADE");
    });
    afterEach(closeClients);
    afterAll(async () => {
      try {
        await closeClients();
      } finally {
        try {
          await admin?.end();
        } finally {
          if (directory) {
            spawnSync(
              path.join(bindir!, "pg_ctl"),
              [
                "-D",
                path.join(directory, "data"),
                "-m",
                "immediate",
                "-w",
                "stop",
              ],
              { stdio: "ignore" },
            );
            rmSync(directory, { recursive: true, force: true });
          }
        }
      }
    });

    function store(name: string, locked?: () => Promise<void>) {
      const connection = client(name);
      const result = createProducerStore("unused-local-test", {
        clientFactory: () => ({
          connect: () => connection.connect(),
          end: () => connection.end(),
          query: async (sql, values) => {
            const result = await connection.query(sql, values);
            if (sql.startsWith("SELECT root_basket_check_replay"))
              await locked?.();
            return result;
          },
        }),
      });
      return result;
    }

    async function assertWaiting(name: string, event = "advisory") {
      for (let i = 0; i < 300; i++) {
        const result = await admin.query(
          "SELECT state, wait_event, pg_blocking_pids(pid) AS blockers, query FROM pg_stat_activity WHERE application_name = $1",
          [name],
        );
        if (result.rows[0]?.wait_event === event) return;
        // Keep native lock coordination independent of shared-registry global
        // timers. PostgreSQL advances this wait even if a test clock is frozen.
        await admin.query("SELECT pg_sleep(0.01)");
      }
      const activity = await admin.query(
        "SELECT application_name, state, wait_event, pg_blocking_pids(pid) AS blockers, query FROM pg_stat_activity WHERE datname = current_database()",
      );
      assert.fail(
        `expected ${name} to wait on ${event}: ${JSON.stringify(activity.rows)}`,
      );
    }

    async function stageIncomplete(capture = syntheticBasketCapture()) {
      // Model rows that predate the receiver: deliberately omit completion in
      // fixture setup. The real receiver rejects this pre-existing partial state.
      const underlying = store("fixture");
      await writeRootBasketCapture(
        {
          ...underlying,
          transaction: (statements) =>
            underlying.transaction(
              statements.filter(
                (statement) =>
                  !statement.text.startsWith(
                    "SELECT root_basket_complete_capture",
                  ),
              ),
            ),
        },
        capture,
        3000,
      );
      return capture;
    }

    test("polling observes a later lock wait with frozen test timers", async () => {
      const capture = await stageIncomplete();
      const completing = client("completing");
      const mutating = client("delayed-mutation");
      await completing.connect();
      await mutating.connect();
      try {
        await completing.query("BEGIN");
        await completing.query(
          "SELECT root_basket_complete_capture($1, $2, 3000)",
          [
            capture.capture_id,
            rootBasketCaptureDigest(RootBasketCaptureSchema.parse(capture)),
          ],
        );
        await mutating.query("BEGIN");
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const waiting = assertWaiting("delayed-mutation", "transactionid");
        // This observer query queues after the initial poll, proving it saw no
        // lock wait before the mutation starts. A first-poll success cannot
        // accidentally bypass the pacing path under test.
        await admin.query("SELECT 1");
        const result = mutating
          .query(
            "UPDATE root_basket_holdings SET quantity_atomic = 17 WHERE capture_id = $1",
            [capture.capture_id],
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        await waiting;
        await completing.query("COMMIT");
        assert.match(
          String(await result),
          /completed root basket observation is immutable/,
        );
      } finally {
        vi.useRealTimers();
        await closeClients();
      }
    });

    test("failed race cleanup disconnects a blocked mutation and releases the next reset", async () => {
      const capture = await stageIncomplete();
      const completing = client("completing");
      const mutating = client("failed-mutation");
      await completing.connect();
      await mutating.connect();
      let result: Promise<unknown> | undefined;
      await assert.rejects(async () => {
        try {
          await completing.query("BEGIN");
          await completing.query(
            "SELECT root_basket_complete_capture($1, $2, 3000)",
            [
              capture.capture_id,
              rootBasketCaptureDigest(RootBasketCaptureSchema.parse(capture)),
            ],
          );
          await mutating.query("BEGIN");
          result = mutating
            .query("DELETE FROM root_basket_holdings WHERE capture_id = $1", [
              capture.capture_id,
            ])
            .then(
              () => null,
              (error: unknown) => error,
            );
          await assertWaiting("failed-mutation", "transactionid");
          assert.fail("injected race assertion failure");
        } finally {
          await closeClients();
        }
      }, /injected race assertion failure/);
      assert.ok(await result, "the blocked mutation must be interrupted");
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM root_basket_capture_completions",
          )
        ).rows[0].n,
        0,
      );
      await admin.query("TRUNCATE root_basket_captures CASCADE");
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM root_basket_captures",
          )
        ).rows[0].n,
        0,
      );
    });

    for (const mutation of ["update", "delete", "insert", "move"] as const) {
      test(`a concurrent child ${mutation} cannot commit after completion`, async () => {
        const capture = await stageIncomplete();
        const other = {
          ...structuredClone(capture),
          capture_id: "00000000-0000-4000-8000-000000000002",
          finalized_block_hash: `0x${"ee".repeat(32)}`,
          finalized_block: "501",
        };
        if (mutation === "move") await stageIncomplete(other);
        const completing = client("completing");
        const mutating = client("mutating");
        await completing.connect();
        await mutating.connect();
        try {
          await completing.query("BEGIN");
          await completing.query(
            "SELECT root_basket_complete_capture($1, $2, 3000)",
            [
              capture.capture_id,
              rootBasketCaptureDigest(RootBasketCaptureSchema.parse(capture)),
            ],
          );
          await mutating.query("BEGIN");
          const sql =
            mutation === "update"
              ? "UPDATE root_basket_holdings SET quantity_atomic = 17 WHERE capture_id = $1"
              : mutation === "delete"
                ? "DELETE FROM root_basket_holdings WHERE capture_id = $1"
                : mutation === "move"
                  ? "UPDATE root_basket_holdings SET capture_id = $1 WHERE capture_id = $2"
                  : "INSERT INTO root_basket_holdings VALUES ($1, $2, 51, 1, 'alpha_atomic', 1, 1)";
          const values =
            mutation === "move"
              ? [capture.capture_id, other.capture_id]
              : mutation === "insert"
                ? [capture.capture_id, capture.funds[0]!.hotkey]
                : [capture.capture_id];
          const result = mutating.query(sql, values).then(
            () => null,
            (error: unknown) => error,
          );
          try {
            await assertWaiting("mutating", "transactionid");
          } finally {
            await completing.query("COMMIT");
          }
          assert.match(
            String(await result),
            /completed root basket observation is immutable/,
          );
          await mutating.query("ROLLBACK");
          const held = await admin.query(
            "SELECT quantity_atomic::text AS quantity FROM root_basket_holdings WHERE capture_id = $1 AND netuid = 0",
            [capture.capture_id],
          );
          assert.equal(held.rows[0].quantity, "1000000000");
        } finally {
          await closeClients();
        }
      });
    }

    test("completion waits for an earlier child delete and rejects the now-incomplete rows", async () => {
      const capture = await stageIncomplete();
      const deleting = client("deleting");
      const completing = client("completing");
      await deleting.connect();
      await completing.connect();
      try {
        await deleting.query("BEGIN");
        await deleting.query(
          "DELETE FROM root_basket_holdings WHERE capture_id = $1 AND netuid = 0",
          [capture.capture_id],
        );
        const result = completing
          .query("SELECT root_basket_complete_capture($1, $2, 3000)", [
            capture.capture_id,
            rootBasketCaptureDigest(RootBasketCaptureSchema.parse(capture)),
          ])
          .then(
            () => null,
            (error: unknown) => error,
          );
        try {
          await assertWaiting("completing", "transactionid");
        } finally {
          await deleting.query("COMMIT");
        }
        assert.match(String(await result), /persisted capture is incomplete/);
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM root_basket_capture_completions",
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await closeClients();
      }
    });

    for (const scenario of [
      "identical",
      "changed_content",
      "same_height_hash",
      "late_history",
      "newer",
      "first_rollback",
    ] as const) {
      test(`serializes ${scenario} without partial publication or current-pointer regression`, async () => {
        const first = syntheticBasketCapture();
        const second = {
          ...structuredClone(first),
          capture_id: "00000000-0000-4000-8000-000000000002",
          started_at_ms: "4000",
          finished_at_ms: "5000",
        };
        if (scenario === "changed_content")
          second.metadata_sha256 = `0x${"ee".repeat(32)}`;
        if (["same_height_hash", "late_history", "newer"].includes(scenario))
          second.finalized_block_hash = `0x${"ee".repeat(32)}`;
        if (scenario === "late_history") second.finalized_block = "499";
        if (scenario === "newer") second.finalized_block = "501";
        let release!: () => void;
        let locked!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        barriers.add(release);
        const ready = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const firstWrite = writeRootBasketCapture(
          store("first", async () => {
            locked();
            await barrier;
            if (scenario === "first_rollback")
              throw new Error("injected pre-insert failure");
          }),
          first,
          3000,
        );
        // A writer failing before acquiring the lock must fail this test, not
        // leave it waiting forever for a callback that will never run.
        await Promise.race([
          ready,
          firstWrite.then(() => {
            throw new Error("first writer completed without the lock barrier");
          }),
        ]);
        const secondWrite = writeRootBasketCapture(
          store("second"),
          second,
          6000,
        );
        const results = Promise.allSettled([firstWrite, secondWrite]);
        try {
          await assertWaiting("second");
        } finally {
          release();
        }
        const [a, b] = await results;
        const conflicting =
          scenario === "changed_content" || scenario === "same_height_hash";
        assert.equal(
          a.status,
          scenario === "first_rollback" ? "rejected" : "fulfilled",
        );
        assert.equal(b.status, conflicting ? "rejected" : "fulfilled");
        if (b.status === "rejected")
          assert.match(String(b.reason), /ROOT_BASKET_CAPTURE_CONFLICT/);
        if (scenario === "identical" && b.status === "fulfilled") {
          assert.equal(b.value.capture_id, first.capture_id);
          assert.equal(b.value.replayed, true);
        }
        const current = await admin.query(
          "SELECT capture_id FROM root_basket_current",
        );
        assert.equal(
          current.rows[0].capture_id,
          scenario === "newer" || scenario === "first_rollback"
            ? second.capture_id
            : first.capture_id,
        );
        const receipts = await admin.query(
          "SELECT count(*)::int AS n FROM root_basket_capture_completions",
        );
        assert.equal(
          receipts.rows[0].n,
          scenario === "late_history" || scenario === "newer" ? 2 : 1,
        );
        await closeClients();
      });
    }
  },
);
