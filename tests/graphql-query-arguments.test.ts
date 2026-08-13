// The Query root's arguments are DERIVED from the routes now (#10214), so the
// gate that says so has to be able to fail.
//
// Every test drives `checkQueryArguments` with a mutated SDL and asserts the
// difference is reported. The gate's own run against the real tree only ever
// proves it passes.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  DECLARED_MISSING_NETWORK,
  checkQueryArguments,
  expiredMissingNetworkReasons,
} from "../scripts/validate-graphql-query-arguments.ts";
import { extractSdl } from "../scripts/validate-graphql-component-parity.ts";
import type { OpenApiParameters } from "../schemas-src/graphql/query-arguments.ts";
import { scalarFor } from "../schemas-src/graphql/query-arguments.ts";

const sdl = extractSdl(readFileSync("generated/graphql/schema.ts", "utf8"))!;
const openapi = JSON.parse(
  readFileSync("public/metagraph/openapi.json", "utf8"),
) as OpenApiParameters;

/** Rewrite inside ONE Query field's argument list. */
function inField(source: string, field: string, find: string, replace: string) {
  const start = source.indexOf(`  ${field}(`);
  assert.notEqual(start, -1, `no Query.${field} in the SDL`);
  const end = source.indexOf("):", start);
  const block = source.slice(start, end);
  assert.equal(
    block.split(find).length - 1,
    1,
    `${find} is not unique in ${field}`,
  );
  return (
    source.slice(0, start) + block.replace(find, replace) + source.slice(end)
  );
}

describe("scalarFor", () => {
  test("network is the published enum, not a String", () => {
    assert.equal(scalarFor({ name: "network", in: "query" }), "Network");
  });

  test("a true/false STRING enum is a real Boolean", () => {
    assert.equal(
      scalarFor({
        name: "changes",
        in: "query",
        schema: { type: "string", enum: ["true", "false"] },
      }),
      "Boolean",
    );
  });

  test("an ordinary string enum stays a String", () => {
    // The rule has to be about the two words, not about `enum` being present:
    // widening every enum to Boolean would retype every sort/order/window.
    assert.equal(
      scalarFor({
        name: "order",
        in: "query",
        schema: { type: "string", enum: ["asc", "desc"] },
      }),
      "String",
    );
  });

  test("integer is Int and number is Float", () => {
    assert.equal(
      scalarFor({ name: "limit", in: "query", schema: { type: "integer" } }),
      "Int",
    );
    assert.equal(
      scalarFor({ name: "amount", in: "query", schema: { type: "number" } }),
      "Float",
    );
  });
});

describe("checkQueryArguments", () => {
  test("every route-backed field reproduces its route's parameters", () => {
    const report = checkQueryArguments(sdl, openapi);
    assert.deepEqual(report.violations, []);
    assert.deepEqual(report.stale, []);
    // 201, up from 189, and the twelve are the point (#10772): the six
    // `route: null` bindings now name the route they always had, and the
    // Subscription root and the two nested filtered lists are inside the check
    // for the first time. The companion assertion is `skipped`, below -- a
    // count of what reproduces exactly means nothing without the count of what
    // was never compared.
    // 203 after #10929 added subnet_owner_capture (202 after #10928's
    // subnet_emission_split_history). Both derive `window` from the route's own
    // query schema rather than restating it, so they land in `exact` rather
    // than in `violations` -- which is the outcome this count exists to
    // confirm. Bumping it is a prompt to check that, not a formality.
    assert.equal(report.exact, 203);
    assert.equal(report.skipped, 0);
  });

  test("it FAILS when an argument's type stops matching the route", () => {
    const broken = inField(sdl, "subnet_ohlc", "limit: Int", "limit: String");
    const report = checkQueryArguments(broken, openapi);
    assert.ok(
      report.violations.some((v) =>
        v.startsWith("Query.subnet_ohlc.limit: the SDL declares String"),
      ),
      `expected the retyped argument to be reported, got: ${report.violations.join("; ")}`,
    );
  });

  test("it FAILS when the SDL drops an argument the route publishes", () => {
    const broken = inField(sdl, "subnet_ohlc", "limit: Int", "");
    const report = checkQueryArguments(broken, openapi);
    assert.ok(
      report.violations.some((v) =>
        v.startsWith("Query.subnet_ohlc.limit: the route publishes it"),
      ),
      `expected the dropped argument to be reported, got: ${report.violations.join("; ")}`,
    );
  });

  test("it FAILS on an argument nothing the route publishes derives to", () => {
    const broken = inField(
      sdl,
      "subnet_ohlc",
      "limit: Int",
      "limit: Int\n      invented: String",
    );
    const report = checkQueryArguments(broken, openapi);
    assert.ok(
      report.violations.some((v) => v.startsWith("Query.subnet_ohlc.invented")),
      `expected the invented argument to be reported, got: ${report.violations.join("; ")}`,
    );
  });

  test("the missing-`network` list only shrinks", () => {
    // A field declared as missing `network` that in fact takes one is a fix
    // whose declaration was left behind -- the same idiom every other DECLARED
    // list in the repo uses.
    const report = checkQueryArguments(sdl, openapi, [
      ...DECLARED_MISSING_NETWORK,
      "subnet_ohlc",
    ]);
    assert.ok(
      report.stale.includes("subnet_ohlc"),
      `expected the stale entry to be reported, got: ${report.stale.join("; ")}`,
    );
  });

  test("an UNDECLARED missing `network` is a violation, not a shrug", () => {
    const report = checkQueryArguments(sdl, openapi, []);
    assert.equal(
      report.violations.filter((v) =>
        v.endsWith("network: the route publishes it, the SDL does not"),
      ).length,
      DECLARED_MISSING_NETWORK.length,
    );
  });
});

// ── the DECLARED_MISSING_NETWORK reason, re-read on every run (#10870) ───────
//
// Each entry cites a resolver fact ("destructures { ref } and nothing else"),
// and a reason nothing re-reads expires silently -- #10863 caught three
// expired `fields` justifications the same day. These drive the checker with
// synthetic resolvers and assert every arm: holds, outgrown, unverifiable.
describe("expiredMissingNetworkReasons", () => {
  test("a resolver that binds only `ref` keeps its entry", () => {
    assert.deepEqual(
      expiredMissingNetworkReasons(
        `const rootValue = { async extrinsic({ ref }: Args) { return ref; } };`,
        ["extrinsic"],
      ),
      [],
    );
  });

  test("FAILS when the resolver starts binding `network` -- the entry is outgrown", () => {
    assert.deepEqual(
      expiredMissingNetworkReasons(
        `const rootValue = { async extrinsic({ ref, network }: Args) { return ref; } };`,
        ["extrinsic"],
      ),
      ["extrinsic"],
    );
  });

  test("FAILS when the resolver stops destructuring -- the cited fact is unreadable", () => {
    assert.deepEqual(
      expiredMissingNetworkReasons(
        `const rootValue = { async extrinsic(args: Args) { return args; } };`,
        ["extrinsic"],
      ),
      ["extrinsic"],
    );
  });

  test("a renamed binding of `network` is still `network`", () => {
    assert.deepEqual(
      expiredMissingNetworkReasons(
        `const rootValue = { async extrinsic({ ref, network: net }: Args) { return net; } };`,
        ["extrinsic"],
      ),
      ["extrinsic"],
    );
  });

  test("the committed resolver still satisfies the committed list", () => {
    assert.deepEqual(
      expiredMissingNetworkReasons(readFileSync("src/graphql.ts", "utf8")),
      [],
    );
  });
});
