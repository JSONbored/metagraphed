import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import { writeCaptureFamilyD1 } from "../src/capture-family-d1.ts";
import {
  FAMILY_MIRROR_PLANS,
  mirrorFamilyToNeon,
} from "../src/hyperparams-identity-neon-write.ts";
import { runSubnetLifecycleLane } from "../src/subnet-lifecycle.ts";
import { writeNeuronDocuments } from "../src/neuron-documents.ts";
import { captureSubnetBurnHistory } from "../src/subnet-burn-history.ts";
import worker from "../workers/data-api.ts";
import { apiEnv, dataApiEnv } from "./helpers/worker-env.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const stamp = 1790090000000;
const tables = Object.values(FAMILY_MIRROR_PLANS).flatMap((p) => [
  p.latest.table,
  p.history.table,
]);
const env = () =>
  dataApiEnv({
    D1_STATE: db,
    D1_STATE_TABLES: tables.join(","),
    HYPERDRIVE: undefined,
  });
const store = () => createD1Store(db);
const plan = (lane: string) => FAMILY_MIRROR_PLANS[lane];
const laneHealthDb = {
  async query() {
    return [];
  },
  async run() {
    return { changes: 1 };
  },
};
const write = (
  lane: string,
  rows: Record<string, unknown>[],
  historyRows: Record<string, unknown>[] = [],
  pruneKeys?: number[],
) =>
  mirrorFamilyToNeon(
    env(),
    null,
    lane,
    { rows, historyRows, pruneKeys },
    { laneHealthDb, now: () => stamp },
  );
const count = (table: string) =>
  db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n");
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const statement of readFileSync(
    new URL("../migrations/d1/0009_subnet_identity_state.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (statement.trim()) await db.prepare(statement).run();
  for (const statement of readFileSync(
    new URL("../migrations/d1/0007_neuron_documents.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (statement.trim()) await db.prepare(statement).run();
});
afterAll(async () => runtime.dispose());
beforeEach(async () => {
  for (const table of [
    ...tables,
    "subnet_burn_history",
    "subnet_lifecycle",
    "neurons_members",
    "neurons_documents",
    "neurons_passes",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});

test("hyperparameters preserve null/boolean/wide values and newer cards while retaining history", async () => {
  const row = {
    netuid: 1,
    captured_at: stamp,
    registration_allowed: true,
    commit_reveal_enabled: false,
    weights_version: 9223372036854775807n,
    bonds_moving_avg_raw: "9007199254740993",
  };
  const result = await write(
    "subnet-hyperparams",
    [row],
    [{ ...row, observed_at: stamp, hyperparams_hash: "one" }],
  );
  assert.equal(result.results.subnet_hyperparams.ok, true);
  const actual = await db.prepare("SELECT * FROM subnet_hyperparams").first();
  assert.equal(actual?.registration_allowed, 1);
  assert.equal(actual?.commit_reveal_enabled, 0);
  assert.equal(actual?.weights_version, "9223372036854775807");
  assert.equal(actual?.bonds_moving_avg_raw, "9007199254740993");
  assert.equal(actual?.tempo, null);
  await write("subnet-hyperparams", [
    { ...row, captured_at: stamp - 1, registration_allowed: false },
  ]);
  assert.equal(
    await db
      .prepare("SELECT registration_allowed FROM subnet_hyperparams")
      .first("registration_allowed"),
    1,
  );
  assert.equal(await count("subnet_hyperparams_history"), 1);
  assert.deepEqual((await write("subnet-hyperparams", [])).results, {});
});
test("content-keyed identity history preserves earliest observation, while its card preserves latest", async () => {
  const row = {
    netuid: 1,
    block_number: 9000000,
    captured_at: stamp,
    identity_hash: "a",
    subnet_name: "First",
  };
  await write("subnet-identity", [row], [{ ...row, observed_at: stamp }]);
  await write(
    "subnet-identity",
    [{ ...row, captured_at: stamp + 1, subnet_name: "Current" }],
    [{ ...row, observed_at: stamp + 1 }],
  );
  await write(
    "subnet-identity",
    [{ ...row, captured_at: stamp - 1 }],
    [{ ...row, observed_at: stamp - 1 }],
  );
  assert.equal(await count("subnet_identity_history"), 1);
  assert.equal(
    await db
      .prepare("SELECT observed_at FROM subnet_identity_history")
      .first("observed_at"),
    stamp - 1,
  );
  assert.equal(
    await db
      .prepare("SELECT subnet_name FROM subnet_identity")
      .first("subnet_name"),
    "Current",
  );
});
test("ownership prunes only the card with a complete nonempty set and retains every revision", async () => {
  const rows = [1, 2].map((netuid) => ({
    netuid,
    owner_hotkey: "hot",
    owner_coldkey: "cold",
    captured_at: stamp,
  }));
  await write("subnet-ownership", rows, rows, [1, 2]);
  await write(
    "subnet-ownership",
    [{ ...rows[0], owner_hotkey: "changed", captured_at: stamp + 1 }],
    [{ ...rows[0], owner_hotkey: "changed", captured_at: stamp + 1 }],
    [1],
  );
  assert.equal(await count("subnet_ownership"), 1);
  assert.equal(await count("subnet_ownership_history"), 3);
  await write("subnet-ownership", [], [], []);
  assert.equal(await count("subnet_ownership"), 1);
  const bad = await write(
    "subnet-ownership",
    [{ ...rows[1], captured_at: stamp + 2 }],
    [],
    [NaN],
  );
  assert.equal(bad.results["subnet_ownership:prune"].ok, false);
  assert.equal(await count("subnet_ownership"), 1);
});
test("late history failure rolls back all card chunks and reports all requested tables", async () => {
  await db
    .prepare(
      "CREATE TRIGGER reject_identity BEFORE INSERT ON account_identity_history BEGIN SELECT RAISE(ABORT,'injected'); END",
    )
    .run();
  const rows = Array.from({ length: 201 }, (_, i) => ({
    account: "a-" + i,
    captured_at: stamp,
    name: "Name",
  }));
  const result = await write("account-identity", rows, [
    { account: "a", observed_at: stamp, identity_hash: "h" },
  ]);
  assert.equal(result.results.account_identity.ok, false);
  assert.equal(result.results.account_identity_history.ok, false);
  assert.equal(await count("account_identity"), 0);
  await db.prepare("DROP TRIGGER reject_identity").run();
  assert.equal(
    (await write("account-identity", rows)).results.account_identity.statements,
    3,
  );
  assert.equal(await count("account_identity"), 201);
});
test("payload bounds split valid rows and reject oversized rows, invalid scalars and oversized transactions atomically", async () => {
  const base = { account: "a", captured_at: stamp };
  const result = await write("account-identity", [
    { ...base, description: "x".repeat(300000) },
    { ...base, account: "b", description: "x".repeat(300000) },
  ]);
  assert.equal(result.results.account_identity.statements, 2);
  assert.equal(await count("account_identity"), 2);
  for (const description of ["x".repeat(524288), {}, Infinity]) {
    const bad = await write("account-identity", [
      { ...base, account: "bad", description },
    ]);
    assert.equal(bad.results.account_identity.ok, false);
    assert.equal(await count("account_identity"), 2);
  }
  const tooMany = Array.from({ length: 90001 }, (_, i) => ({
    ...base,
    account: "large-" + i,
  }));
  const bad = await writeCaptureFamilyD1(store(), plan("account-identity"), {
    rows: tooMany,
    historyRows: [],
  });
  assert.equal(bad.account_identity.ok, false);
  assert.match(bad.account_identity.reason!, /atomic statement budget/);
  assert.equal(await count("account_identity"), 2);
});
test("native lifecycle window queries and writes preserve seed and deregistration semantics", async () => {
  const options = { laneHealthDb, coverageFloor: 1, now: () => stamp };
  const selected = {
    D1_STATE: db,
    D1_STATE_TABLES: "neurons,neurons_passes,subnet_lifecycle",
  };
  const capture = async (netuids: number[], at: number) => {
    await writeNeuronDocuments(store(), {
      rows: netuids.map((netuid) => ({
        netuid,
        uid: 0,
        block_number: 9000000,
        captured_at: at,
      })),
      dailyRows: [],
      positionRows: [],
    });
    await db
      .prepare("INSERT INTO neurons_passes VALUES(?,?,?,?)")
      .bind(at, netuids.length, netuids.length, at + 1)
      .run();
  };
  await capture([1, 2], stamp);
  assert.equal((await runSubnetLifecycleLane(selected, options)).seeded, true);
  assert.equal(
    await db
      .prepare("SELECT SUM(predates_capture) AS n FROM subnet_lifecycle")
      .first("n"),
    2,
  );
  await db.prepare("DELETE FROM neurons_members WHERE netuid=2").run();
  await capture([1], stamp + 1);
  const result = await runSubnetLifecycleLane(selected, {
    ...options,
    now: () => stamp + 1,
  });
  assert.equal(result.events, 1);
  assert.equal(
    await db
      .prepare("SELECT event FROM subnet_lifecycle ORDER BY id DESC LIMIT 1")
      .first("event"),
    "deregistered",
  );
});
test("a missing chunk above the netuid floor never invents lifecycle removals", async () => {
  const selected = {
    D1_STATE: db,
    D1_STATE_TABLES: "neurons,neurons_passes,subnet_lifecycle",
  };
  const options = { laneHealthDb, now: () => stamp + 600000 };
  const all = Array.from({ length: 129 }, (_, netuid) => ({
    netuid,
    uid: 0,
    block_number: 9000000,
    captured_at: stamp,
  }));
  await writeNeuronDocuments(store(), {
    rows: all,
    dailyRows: [],
    positionRows: [],
  });
  await db
    .prepare("INSERT INTO neurons_passes VALUES(?,?,?,?)")
    .bind(stamp, 129, 129, stamp + 1)
    .run();
  assert.equal((await runSubnetLifecycleLane(selected, options)).events, 129);
  await writeNeuronDocuments(store(), {
    rows: all
      .slice(0, 108)
      .map((row) => ({ ...row, captured_at: stamp + 600000 })),
    dailyRows: [],
    positionRows: [],
  });
  const before = await count("subnet_lifecycle");
  // An absent receipt and an incomplete one both decline, despite 108 > 103.
  assert.equal(
    (await runSubnetLifecycleLane(selected, options)).reason,
    "partial",
  );
  await db
    .prepare("INSERT INTO neurons_passes VALUES(?,?,?,NULL)")
    .bind(stamp + 600000, 129, 108)
    .run();
  assert.equal(
    (await runSubnetLifecycleLane(selected, options)).reason,
    "partial",
  );
  // At-least-once delivery can inflate the tally: the missing rows still matter.
  await db
    .prepare(
      "UPDATE neurons_passes SET received_rows=258,completed_at=? WHERE captured_at=?",
    )
    .bind(stamp + 600001, stamp + 600000)
    .run();
  assert.equal(
    (await runSubnetLifecycleLane(selected, options)).reason,
    "partial",
  );
  assert.equal(await count("subnet_lifecycle"), before);
  await writeNeuronDocuments(store(), {
    rows: all
      .slice(108)
      .map((row) => ({ ...row, captured_at: stamp + 600000 })),
    dailyRows: [],
    positionRows: [],
  });
  assert.equal((await runSubnetLifecycleLane(selected, options)).events, 0);
  // A complete document cannot compensate for a missing/mis-sharded member.
  await db.prepare("UPDATE neurons_members SET shard=9 WHERE netuid=0").run();
  assert.equal(
    (await runSubnetLifecycleLane(selected, options)).reason,
    "partial",
  );
  assert.equal(await count("subnet_lifecycle"), before);
});
test("a complete-looking membership set needs a completed, adequate receipt", async () => {
  const selected = {
    D1_STATE: db,
    D1_STATE_TABLES: "neurons,neurons_passes,subnet_lifecycle",
  };
  const options = { laneHealthDb, coverageFloor: 1, now: () => stamp };
  await writeNeuronDocuments(store(), {
    rows: [{ netuid: 0, uid: 0, block_number: 9, captured_at: stamp }],
    dailyRows: [],
    positionRows: [],
  });
  await db
    .prepare("INSERT INTO neurons_passes VALUES(?,?,?,NULL)")
    .bind(stamp, 1, 1)
    .run();
  assert.equal(
    (await runSubnetLifecycleLane(selected, options)).reason,
    "partial",
  );
  await db
    .prepare("UPDATE neurons_passes SET received_rows=0,completed_at=?")
    .bind(stamp + 1)
    .run();
  assert.equal(
    (await runSubnetLifecycleLane(selected, options)).reason,
    "partial",
  );
  assert.equal(await count("subnet_lifecycle"), 0);
  const failed = await runSubnetLifecycleLane(
    { ...selected, D1_STATE_TABLES: "neurons,subnet_lifecycle" },
    options,
  );
  assert.equal(failed.reason, "query_failed");
  assert.match(String(failed.detail), /spans D1 and Neon/);
});
test("burn capture records every subnet and retries without duplicates", async () => {
  const result = await captureSubnetBurnHistory(apiEnv({}), {
    db: store(),
    now: () => stamp,
    load: async () => ({
      subnets: [
        { netuid: 1, burn_tao: 0 },
        { netuid: 2, burn_tao: 0.005 },
      ],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.captured, 2);
});
test("Data API capture and history-diff routes work without Hyperdrive", async () => {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
  } as ExecutionContext;
  const environment = dataApiEnv({
    ...env(),
    SUBNET_HYPERPARAMS_SYNC_SECRET: "fixture-token",
    ACCOUNT_IDENTITY_SYNC_SECRET: "fixture-token",
  });
  async function post(lane: string, body: unknown) {
    const response = await worker.fetch(
      new Request("https://example.com/api/v1/internal/" + lane, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ["x-" + lane.replace("-backfill", "-sync") + "-token"]:
            "fixture-token",
        },
        body: JSON.stringify(body),
      }),
      environment,
      ctx,
    );
    assert.equal(response.status, 200, await response.clone().text());
    await Promise.all(pending);
    return response.json();
  }
  const hp = {
    netuid: 1,
    captured_at: stamp,
    tempo: 360,
    block_number: 9000000,
  };
  await post("subnet-hyperparams-sync", [hp]);
  await post("subnet-hyperparams-sync", [{ ...hp, captured_at: stamp + 1 }]);
  assert.equal(await count("subnet_hyperparams_history"), 1);
  await post("subnet-hyperparams-backfill", [
    {
      netuid: 1,
      block_number: 8999000,
      observed_at: stamp - 1000,
      hyperparameters: { tempo: 100 },
    },
  ]);
  assert.equal(await count("subnet_hyperparams_history"), 2);
  const account = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
  await post("account-identity-sync", [
    { account, captured_at: stamp, name: "Fixture" },
  ]);
  await post("account-identity-sync", [
    { account, captured_at: stamp + 1, name: "Fixture" },
  ]);
  assert.equal(await count("account_identity_history"), 1);
});
