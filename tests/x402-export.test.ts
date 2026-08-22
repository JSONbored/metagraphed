// #11600: the one route family that REQUIRES payment, and the reason it can.
//
// Every other route on this API serves an unpaid caller normally -- that is
// the invariant infra#629 shipped and tests/x402-routes.test.ts guards. The
// `export` family is the deliberate exception, and it is only defensible
// because it is NEW: nothing was ever served from it for free, apps/ui does
// not call it, and no free tier was withdrawn to create it. The invariant
// protects calls that would otherwise have succeeded; there were none here.
//
// So these tests are written in pairs. Every assertion that the export route
// demands payment is matched by one that its free twin still does not.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import {
  X402_REQUIRED_FAMILIES,
  x402PriceFor,
  x402RequiresPayment,
} from "../src/x402.ts";
import { routeCost } from "../src/route-cost-weights.ts";
import {
  EXPORT_CHAIN_EVENTS_LIMIT_DEFAULT,
  EXPORT_CHAIN_EVENTS_LIMIT_MAX,
} from "../src/route-limits.ts";
import { CHAIN_EVENTS_LIMIT_MAX } from "../src/route-limits.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const PAY_TO = "0x224809C91CF942d00ef04b23f7BaB87d5DA5013f";
const EXPORT = "/api/v1/export/chain-events";
const FREE = "/api/v1/chain-events";

const paidEnv = () => mockEnv({ X402_PAY_TO: PAY_TO });
const get = (path: string, env: Env) =>
  handleRequest(new Request(`https://api.metagraph.sh${path}?limit=5`), env);

describe("x402RequiresPayment", () => {
  test("is true for the export family and false for everything else", () => {
    assert.equal(x402RequiresPayment(EXPORT), true);
    for (const path of [FREE, "/api/v1/ask", "/api/v1/subnets", "/mcp"]) {
      assert.equal(x402RequiresPayment(path), false, path);
    }
  });

  test("every required family is also a PAID family", () => {
    // A family that demands payment but has no price would 402 with a quote
    // of nothing, which a client cannot satisfy.
    for (const family of X402_REQUIRED_FAMILIES) {
      const priced = ["/api/v1/export/chain-events"].some(
        (p) => routeCost(p).family === family && x402PriceFor(p),
      );
      assert.ok(priced, `${family} demands payment but prices nothing`);
    }
  });
});

describe("the export route demands payment", () => {
  test("402 with a quote when none is presented", async () => {
    const res = await get(EXPORT, paidEnv());
    assert.equal(res.status, 402);
    assert.ok(res.headers.get("payment-required"), "the quote must be there");
    const accepts = ((await jsonBody(res)).accepts as Row[])[0]!;
    assert.equal(accepts.payTo, PAY_TO);
  });

  test("and its FREE twin does not, in the same deployment", async () => {
    // The pair that matters. Same env, same request shape, opposite answer.
    const res = await get(FREE, paidEnv());
    assert.notEqual(res.status, 402);
  });

  test("a malformed payment is still 400, not 402", async () => {
    // The caller DID present something. Telling them to pay again for an
    // encoding problem is a loop they cannot exit.
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${EXPORT}`, {
        headers: { "payment-signature": "!!!" },
      }),
      paidEnv(),
    );
    assert.equal(res.status, 400);
  });
});

describe("a deployment that cannot collect does not pretend to", () => {
  test("no X402_PAY_TO means the export serves like any other route", async () => {
    // Fails OPEN here, alone in this module, and deliberately: a 402 quoting
    // an address the deployment does not have is a bill nobody can pay. The
    // route degrades to its normal answer instead.
    const res = await get(EXPORT, mockEnv({}));
    assert.notEqual(res.status, 402);
  });
});

describe("the export tier is priced from the cost model", () => {
  test("costs more than the paginated read it replaces", () => {
    const exportPrice = Number(x402PriceFor(EXPORT)!.atomicAmount);
    const pagePrice = Number(x402PriceFor(FREE)!.atomicAmount);
    assert.ok(
      exportPrice > pagePrice,
      `export ${exportPrice} must exceed a page ${pagePrice}`,
    );
  });

  test("its ceiling is far above the free page, which IS the product", () => {
    assert.ok(EXPORT_CHAIN_EVENTS_LIMIT_MAX > CHAIN_EVENTS_LIMIT_MAX * 100);
    assert.ok(
      EXPORT_CHAIN_EVENTS_LIMIT_DEFAULT < EXPORT_CHAIN_EVENTS_LIMIT_MAX,
      "a default at the ceiling makes ?limit meaningless",
    );
  });

  test("`export` sorts before `deep-history`, or it would price as one", () => {
    // /api/v1/export/chain-events matches the deep-history pattern too. If
    // that entry won, an export would be billed at a twelfth of its cost.
    assert.equal(routeCost(EXPORT).family, "export");
    assert.equal(routeCost(FREE).family, "deep-history");
  });
});
