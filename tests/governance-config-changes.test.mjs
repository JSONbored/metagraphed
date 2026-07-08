import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// A D1 mock that records the bound SQL/params and returns the given feed rows
// for the paginated SELECT — mirrors dbWith in tests/sudo.test.mjs.
function dbWith(feed, captured = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        captured.sql = sql;
        return {
          bind(...params) {
            captured.params = params;
            return {
              async all() {
                if (/LIMIT \? OFFSET \?/.test(sql) || /LIMIT \?$/.test(sql)) {
                  return { results: feed || [] };
                }
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

function configChangeRow(overrides = {}) {
  return {
    block_number: 300,
    extrinsic_index: 3,
    extrinsic_hash: `0x${"c".repeat(64)}`,
    signer: "5AdminKey",
    call_module: "AdminUtils",
    call_function: "sudo_set_tempo",
    call_args: JSON.stringify([{ netuid: 5 }, { tempo: 500 }]),
    success: 1,
    fee_tao: 0.000123,
    tip_tao: 0,
    observed_at: 1750009000000,
    ...overrides,
  };
}

test("GET /api/v1/governance/config-changes returns the AdminUtils-filtered feed newest-first (#4310/2.3)", async () => {
  const captured = {};
  const env = dbWith([configChangeRow()], captured);
  const res = await handleRequest(
    req("/api/v1/governance/config-changes"),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.extrinsic_count, 1);
  assert.equal(body.data.extrinsics[0].block_number, 300);
  assert.equal(body.data.extrinsics[0].call_module, "AdminUtils");
  assert.equal(body.data.extrinsics[0].call_function, "sudo_set_tempo");
  assert.equal(body.data.extrinsics[0].success, true);
});

test("GET /api/v1/governance/config-changes hardcodes call_module='AdminUtils' regardless of other filters", async () => {
  const captured = {};
  const env = dbWith([], captured);
  await handleRequest(
    req("/api/v1/governance/config-changes?call_function=sudo_set_kappa"),
    env,
    {},
  );
  assert.match(captured.sql, /call_module = \?/);
  assert.ok(
    captured.params.includes("AdminUtils"),
    `expected "AdminUtils" bound in ${JSON.stringify(captured.params)}`,
  );
  assert.match(captured.sql, /call_function = \?/);
  assert.ok(captured.params.includes("sudo_set_kappa"));
});

test("GET /api/v1/governance/config-changes rejects signer and call_module as query params (both are fixed)", async () => {
  const resSigner = await handleRequest(
    req("/api/v1/governance/config-changes?signer=5Anyone"),
    dbWith([]),
    {},
  );
  assert.equal(resSigner.status, 400);

  const resCallModule = await handleRequest(
    req("/api/v1/governance/config-changes?call_module=Sudo"),
    dbWith([]),
    {},
  );
  assert.equal(resCallModule.status, 400);
});

test("GET /api/v1/governance/config-changes rejects an unsupported query param with 400", async () => {
  const res = await handleRequest(
    req("/api/v1/governance/config-changes?foo=bar"),
    dbWith([]),
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /api/v1/governance/config-changes rejects a non-numeric value filter with 400", async () => {
  const res = await handleRequest(
    req("/api/v1/governance/config-changes?block=abc"),
    dbWith([]),
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /api/v1/governance/config-changes rejects an unsupported success value with 400", async () => {
  const res = await handleRequest(
    req("/api/v1/governance/config-changes?success=maybe"),
    dbWith([]),
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /api/v1/governance/config-changes?success=true binds success=1", async () => {
  const captured = {};
  await handleRequest(
    req("/api/v1/governance/config-changes?success=true"),
    dbWith([], captured),
    {},
  );
  assert.match(captured.sql, /success = \?/);
  assert.ok(captured.params.includes(1));
});

test("GET /api/v1/governance/config-changes?success=false binds success=0", async () => {
  const captured = {};
  await handleRequest(
    req("/api/v1/governance/config-changes?success=false"),
    dbWith([], captured),
    {},
  );
  assert.match(captured.sql, /success = \?/);
  assert.ok(captured.params.includes(0));
});

test("GET /api/v1/governance/config-changes?block=<n> scopes the feed to one block", async () => {
  const captured = {};
  await handleRequest(
    req("/api/v1/governance/config-changes?block=300"),
    dbWith([], captured),
    {},
  );
  assert.match(captured.sql, /block_number = \?/);
  assert.ok(captured.params.includes(300));
});

test("GET /api/v1/governance/config-changes is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(
    req("/api/v1/governance/config-changes"),
    dbWith([]),
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.extrinsics, []);
  assert.equal(body.data.extrinsic_count, 0);
});

test("GET /api/v1/governance/config-changes?format=csv downloads the filtered rows as CSV", async () => {
  const res = await handleRequest(
    req("/api/v1/governance/config-changes?format=csv"),
    dbWith([configChangeRow()]),
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/csv/);
  const text = await res.text();
  assert.match(text, /call_module/);
  assert.match(text, /AdminUtils,sudo_set_tempo/);
});
