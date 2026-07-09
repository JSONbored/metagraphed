import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// A D1 mock that records the bound SQL/params and returns the given feed rows
// for the paginated SELECT — mirrors dbWith in tests/extrinsics.test.mjs.
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

function sudoRow(overrides = {}) {
  return {
    block_number: 200,
    extrinsic_index: 1,
    extrinsic_hash: `0x${"a".repeat(64)}`,
    signer: "5SudoKey",
    call_module: "Sudo",
    call_function: "sudo",
    call_args: JSON.stringify([{ call_function: "sudo_set_tempo" }]),
    success: 1,
    fee_tao: 0.000123,
    tip_tao: 0,
    observed_at: 1750009000000,
    ...overrides,
  };
}

test("GET /api/v1/sudo returns the Sudo-filtered feed newest-first (#4310/2.2)", async () => {
  const captured = {};
  const env = dbWith([sudoRow()], captured);
  const res = await handleRequest(req("/api/v1/sudo"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.extrinsic_count, 1);
  assert.equal(body.data.extrinsics[0].block_number, 200);
  assert.equal(body.data.extrinsics[0].call_module, "Sudo");
  assert.equal(body.data.extrinsics[0].call_function, "sudo");
  assert.equal(body.data.extrinsics[0].success, true);
});

test("GET /api/v1/sudo hardcodes call_module='Sudo' regardless of other filters", async () => {
  const captured = {};
  const env = dbWith([], captured);
  await handleRequest(req("/api/v1/sudo?call_function=sudo_as"), env, {});
  assert.match(captured.sql, /call_module = \?/);
  assert.ok(
    captured.params.includes("Sudo"),
    `expected "Sudo" bound in ${JSON.stringify(captured.params)}`,
  );
  assert.match(captured.sql, /call_function = \?/);
  assert.ok(captured.params.includes("sudo_as"));
});

test("GET /api/v1/sudo rejects signer and call_module as query params (both are fixed, not user-controlled)", async () => {
  const resSigner = await handleRequest(
    req("/api/v1/sudo?signer=5Anyone"),
    dbWith([]),
    {},
  );
  assert.equal(resSigner.status, 400);

  const resCallModule = await handleRequest(
    req("/api/v1/sudo?call_module=SubtensorModule"),
    dbWith([]),
    {},
  );
  assert.equal(resCallModule.status, 400);
});

test("GET /api/v1/sudo rejects an unsupported query param with 400", async () => {
  const res = await handleRequest(req("/api/v1/sudo?foo=bar"), dbWith([]), {});
  assert.equal(res.status, 400);
});

test("GET /api/v1/sudo rejects a non-numeric value filter with 400", async () => {
  const res = await handleRequest(
    req("/api/v1/sudo?block=abc"),
    dbWith([]),
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /api/v1/sudo rejects an unsupported success value with 400", async () => {
  const res = await handleRequest(
    req("/api/v1/sudo?success=maybe"),
    dbWith([]),
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /api/v1/sudo?success=true binds success=1", async () => {
  const captured = {};
  await handleRequest(
    req("/api/v1/sudo?success=true"),
    dbWith([], captured),
    {},
  );
  assert.match(captured.sql, /success = \?/);
  assert.ok(captured.params.includes(1));
});

test("GET /api/v1/sudo?success=false binds success=0", async () => {
  const captured = {};
  await handleRequest(
    req("/api/v1/sudo?success=false"),
    dbWith([], captured),
    {},
  );
  assert.match(captured.sql, /success = \?/);
  assert.ok(captured.params.includes(0));
});

test("GET /api/v1/sudo?block=<n> scopes the feed to one block", async () => {
  const captured = {};
  await handleRequest(req("/api/v1/sudo?block=200"), dbWith([], captured), {});
  assert.match(captured.sql, /block_number = \?/);
  assert.ok(captured.params.includes(200));
});

test("GET /api/v1/sudo is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(req("/api/v1/sudo"), dbWith([]), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.extrinsics, []);
  assert.equal(body.data.extrinsic_count, 0);
});

test("GET /api/v1/sudo?format=csv downloads the filtered rows as CSV", async () => {
  const res = await handleRequest(
    req("/api/v1/sudo?format=csv"),
    dbWith([sudoRow()]),
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/csv/);
  const text = await res.text();
  assert.equal(
    text.split("\r\n")[0],
    "extrinsic_id,block_number,signer,call_module,call_function,success",
  );
  assert.match(text, /Sudo,sudo/);
});
