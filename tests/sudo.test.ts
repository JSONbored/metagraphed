import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import type { Row } from "./row-type.ts";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// A D1 mock that records the bound SQL/params and returns the given feed rows
// for the paginated SELECT — mirrors dbWith in tests/extrinsics.test.mjs.
function dbWith(feed: Row[], captured: Row = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql: string) {
        captured.sql = sql;
        return {
          bind(...params: unknown[]) {
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

test("GET /api/v1/sudo is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(req("/api/v1/sudo"), dbWith([]), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.extrinsics, []);
  assert.equal(body.data.extrinsic_count, 0);
});

test("GET /api/v1/sudo?format=csv exports the filtered rows via the Postgres tier", async () => {
  const env = {
    METAGRAPH_EXTRINSICS_SOURCE: "postgres",
    DATA_API: {
      fetch: async () =>
        Response.json({
          schema_version: 1,
          extrinsic_count: 1,
          limit: 50,
          offset: 0,
          next_cursor: null,
          extrinsics: [
            {
              block_number: 200,
              extrinsic_index: 1,
              extrinsic_hash: `0x${"a".repeat(64)}`,
              signer: "5SudoKey",
              call_module: "Sudo",
              call_function: "sudo",
              call_args: null,
              success: true,
              fee_tao: 0.000123,
              tip_tao: 0,
              observed_at: new Date(1750009000000).toISOString(),
            },
          ],
        }),
    },
  };
  const res = await handleRequest(req("/api/v1/sudo?format=csv"), env, {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  const lines = (await res.text()).trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^200-1,200,5SudoKey,Sudo,sudo,true/);
});
