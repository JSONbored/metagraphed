// The single checksum guard over every /api/v1/accounts/{ss58}/… route (#10036).
//
// Before it, 21 of the 25 account routes shape-checked the address with a
// base58 regex and never verified its checksum, so a one-character typo — the
// exact shape a mistyped address has — came back as a confident empty result
// rather than an error. Only the four live-chain routes (balance, root-claim,
// children, parents) rejected it, and only because they had to decode the
// address before spending an RPC call.
//
// The route list is read from the published contract rather than hand-listed,
// so an account route added later is covered without anyone remembering to.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { mockEnv } from "./row-type.ts";

// A real finney address (a live top holder), and the same address with its
// checksum broken: base58 alphabet, correct length, wrong trailing bytes.
const VALID = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const BAD_CHECKSUM = "5EYCAe5jLQhn6ofDSvqFmCXAEZUZ2VZbtnPZmZmnUJVEexHY";

const openapi = JSON.parse(
  readFileSync("public/metagraph/openapi.json", "utf8"),
) as { paths: Record<string, unknown> };

const ACCOUNT_ROUTES = Object.keys(openapi.paths).filter((path) =>
  path.includes("/accounts/{ss58}"),
);

function fill(route: string, ss58: string) {
  return route
    .replace("{ss58}", ss58)
    .replace("{network}", "finney")
    .replace("{netuid}", "3");
}

async function call(path: string) {
  return handleRequest(
    new Request(`https://api.metagraph.sh${path}`),
    mockEnv(),
    {},
  );
}

describe("account ss58 checksum guard", () => {
  test("the contract publishes the account routes this guard covers", () => {
    // If the filter stops matching, every assertion below passes vacuously.
    assert.ok(
      ACCOUNT_ROUTES.length >= 25,
      `expected the account route family, found ${ACCOUNT_ROUTES.length}`,
    );
  });

  test("every account route rejects a bad-checksum address", async () => {
    const accepted: string[] = [];
    for (const route of ACCOUNT_ROUTES) {
      const res = await call(fill(route, BAD_CHECKSUM));
      const body = (await res.json()) as { error?: { code?: string } };
      if (res.status !== 400 || body.error?.code !== "invalid_ss58") {
        accepted.push(`${route} -> ${res.status} ${body.error?.code ?? "ok"}`);
      }
    }
    assert.deepEqual(accepted, []);
  });

  test("a shape-valid address is not rejected by the guard", async () => {
    // The guard must not over-reject: with no bindings these routes fail or
    // serve empty for their own reasons, but never with invalid_ss58. This is
    // what makes the test above meaningful rather than "everything 400s".
    for (const route of ACCOUNT_ROUTES) {
      const res = await call(fill(route, VALID));
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      assert.notEqual(
        body.error?.code,
        "invalid_ss58",
        `${route} rejected a valid address`,
      );
    }
  });

  test("an address-unshaped segment still 404s at the router", async () => {
    // The two failure modes are different answers and both are correct: a
    // segment that is not address-SHAPED matches no account route at all, so
    // the path identifies nothing and 404 is the honest reply. Only a segment
    // that IS shaped and fails the checksum is a malformed path parameter.
    // Widening the guard's capture to any segment collapses the first into the
    // second — two pre-existing tests caught exactly that, and this pins it
    // from the guard's own side.
    for (const path of [
      "/api/v1/accounts/not-an-address/children",
      "/api/v1/accounts/not-a-valid-address/subnets/7/history",
    ]) {
      const res = await call(path);
      assert.equal(res.status, 404, path);
    }
  });
});
