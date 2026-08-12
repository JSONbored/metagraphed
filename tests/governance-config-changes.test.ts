import assert from "node:assert/strict";
import { lakehouse, LAKEHOUSE_ENV } from "./helpers/cold-tier-env.ts";
import { test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// A D1 mock that records the bound SQL/params and returns the given feed rows
// for the paginated SELECT — mirrors dbWith in tests/sudo.test.ts.
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

test("GET /api/v1/governance/config-changes rejects signer and call_module as query params (both are fixed)", async () => {
  const resSigner = await handleRequest(
    req("/api/v1/governance/config-changes?signer=5Anyone"),
    dbWith([]) as unknown as Env,
    {},
  );
  assert.equal(resSigner.status, 400);

  const resCallModule = await handleRequest(
    req("/api/v1/governance/config-changes?call_module=Sudo"),
    dbWith([]) as unknown as Env,
    {},
  );
  assert.equal(resCallModule.status, 400);
});

test("GET /api/v1/governance/config-changes rejects an unsupported query param with 400", async () => {
  const res = await handleRequest(
    req("/api/v1/governance/config-changes?foo=bar"),
    dbWith([]) as unknown as Env,
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /api/v1/governance/config-changes rejects a non-numeric value filter with 400", async () => {
  const res = await handleRequest(
    req("/api/v1/governance/config-changes?block=abc"),
    dbWith([]) as unknown as Env,
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /api/v1/governance/config-changes rejects an unsupported success value with 400", async () => {
  const res = await handleRequest(
    req("/api/v1/governance/config-changes?success=maybe"),
    dbWith([]) as unknown as Env,
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /api/v1/governance/config-changes is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(
    req("/api/v1/governance/config-changes"),
    dbWith([]) as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.extrinsics, []);
  assert.equal(body.data.extrinsic_count, 0);
});

test("GET /api/v1/governance/config-changes?format=csv exports the filtered rows via the Postgres tier", async () => {
  // #10190: METAGRAPH_EXTRINSICS_SOURCE reads "retired" in wrangler.jsonc and is
  // absent from FORWARDABLE_TIER_FLAGS, so the tier this doubled was never asked.
  // The lakehouse cold tier answers, and it feeds the SAME buildExtrinsicFeed --
  // so the CSV below is produced from lakehouse rows exactly as in production.
  const lake = lakehouse([
    {
      block_number: 300,
      extrinsic_index: 3,
      extrinsic_hash: `0x${"c".repeat(64)}`,
      signer: "5AdminKey",
      call_module: "AdminUtils",
      call_function: "sudo_set_tempo",
      call_args: null,
      success: true,
      fee_tao: 0.000123,
      tip_tao: 0,
      observed_at: new Date(1750009000000).toISOString(),
    },
  ]);
  const env = { ...LAKEHOUSE_ENV };
  const res = await handleRequest(
    req("/api/v1/governance/config-changes?format=csv"),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  const lines = (await res.text()).trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^300-3,300,5AdminKey,AdminUtils,sudo_set_tempo,true/);
  lake.restore();
});
