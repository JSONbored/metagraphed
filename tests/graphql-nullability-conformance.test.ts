// The nullability sweep is the evidence the SDL cutover rests on, so it has to
// be able to report a null AND to not invent one.
//
// The second half is not hypothetical. The first version of this walked the
// answer as the GENERATED type, and where the two schemas disagree about a
// field's type that reported 18 `EndpointIncident` fields as null on 232 rows
// for a path production does not expose at all. Every test here drives it with
// a fetch double rather than the live surface.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { checkNullability } from "../scripts/check-graphql-nullability.ts";
import type { OpenApiParameters } from "../schemas-src/graphql/query-arguments.ts";

const openapi = JSON.parse(
  readFileSync("public/metagraph/openapi.json", "utf8"),
) as OpenApiParameters;

/** A fetch double that answers one Query field and errors on every other. */
function answering(field: string, data: unknown): typeof fetch {
  return (async (_url: string, init?: { body?: string }) => {
    const query = String(JSON.parse(String(init?.body ?? "{}")).query ?? "");
    const asked = /^\{ (\w+)/.exec(query)?.[1];
    return {
      json: async () =>
        asked === field
          ? { data: { [field]: data } }
          : { errors: [{ message: "not the field under test" }] },
    };
  }) as unknown as typeof fetch;
}

describe("graphql nullability conformance", () => {
  test("reports a null under a generated non-null, and how to reproduce it", async () => {
    // `subnets` returns SubnetList; its `total` is non-null in both schemas.
    const report = await checkNullability(
      openapi,
      answering("subnets", { total: null, items: [] }),
    );
    const finding = report.findings.find((f) => f.field === "SubnetList.total");
    assert.ok(
      finding,
      `expected SubnetList.total, got ${report.findings.map((f) => f.field).join(", ")}`,
    );
    assert.equal(finding.nulls, 1);
    assert.equal(finding.seen, 1);
    assert.equal(finding.via, "subnets", "a finding must name the query");
  });

  test("a real value is not a finding", async () => {
    const report = await checkNullability(
      openapi,
      answering("subnets", { total: 546, items: [] }),
    );
    assert.deepEqual(
      report.findings.filter((f) => f.field.startsWith("SubnetList.")),
      [],
    );
    assert.ok(report.observed > 0, "the field must have been observed");
  });

  test("a GraphQL error is a SKIP, not a finding", async () => {
    // A field that errors tells us nothing about its producer's nulls, and
    // counting it either way would be a lie in one direction or the other.
    const report = await checkNullability(openapi, answering("nothing", {}));
    assert.deepEqual(report.findings, []);
    assert.ok(report.skipped.length > 100, "every field should have skipped");
    assert.ok(
      report.skipped.some((line) => line.includes("not the field under test")),
      "the skip must carry the reason",
    );
  });

  test("a field the SERVED schema lacks is not judged", async () => {
    // The regression that produced 18 false findings: the answer is shaped by
    // the published schema, so a generated-only field cannot be read off it.
    // `IncidentList.incidents` is `[EndpointIncident!]!` in both now, but the
    // walk must still refuse to judge a type the served schema does not name.
    const report = await checkNullability(
      openapi,
      answering("subnets", { total: 1, items: [{ invented_by_a_test: null }] }),
    );
    assert.ok(
      !report.findings.some((f) => f.field.includes("invented_by_a_test")),
      "a field neither schema declares must not be reported",
    );
  });

  test("a null inside a LIST row is found, not just at the top level", async () => {
    const report = await checkNullability(
      openapi,
      answering("subnets", { total: 1, items: [{ netuid: null }] }),
    );
    assert.ok(
      report.findings.some((f) => f.field === "Subnet.netuid"),
      `expected Subnet.netuid, got ${report.findings.map((f) => f.field).join(", ")}`,
    );
  });
});

describe("a refused query is split, not abandoned", () => {
  /**
   * A surface that refuses anything over `budget` characters the way the real
   * one refuses on complexity -- a 4xx-shaped body carrying a GraphQL `errors`
   * array -- and answers whatever fits.
   *
   * The probe asks for every non-null leaf at once, so the biggest and most
   * important types are exactly the ones it cannot ask for in one query. Before
   * the split those Query fields were SKIPPED, which is zero evidence for every
   * leaf under them while the run still reported success.
   */
  function refusingOver(
    budget: number,
    field: string,
    data: unknown,
  ): { fetch: typeof fetch; asked: () => number } {
    let asks = 0;
    const impl = (async (_url: string, init?: { body?: string }) => {
      const query = String(JSON.parse(String(init?.body ?? "{}")).query ?? "");
      const target = /^\{ (\w+)/.exec(query)?.[1] === field;
      if (target) asks += 1;
      if (target && query.length > budget) {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            errors: [
              { message: "Query complexity 51 exceeds the limit of 50." },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () =>
          target
            ? { data: { [field]: data } }
            : { errors: [{ message: "not the field under test" }] },
      };
    }) as unknown as typeof fetch;
    return { fetch: impl, asked: () => asks };
  }

  test("the leaves are still observed, over several smaller queries", async () => {
    const probe = refusingOver(400, "subnets", { total: 1, items: [] });
    const report = await checkNullability(openapi, probe.fetch);
    assert.ok(
      probe.asked() > 1,
      "a refusal must produce more than the one query that was refused",
    );
    assert.ok(
      report.observed > 0,
      "splitting must recover evidence, not just avoid the error",
    );
    assert.ok(
      !report.skipped.some((s) => s.startsWith("subnets --")),
      `subnets was skipped anyway: ${report.skipped.join("; ")}`,
    );
  });

  test("a null found in a SPLIT query is still a finding", async () => {
    // The halves each carry part of the selection, so a finding has to survive
    // being reported from a sub-query rather than the whole one.
    const probe = refusingOver(400, "subnets", {
      total: null,
      items: [{ netuid: null }],
    });
    const report = await checkNullability(openapi, probe.fetch);
    for (const field of ["SubnetList.total", "Subnet.netuid"]) {
      assert.ok(
        report.findings.some((f) => f.field === field),
        `expected ${field}, got ${report.findings.map((f) => f.field).join(", ")}`,
      );
    }
  });

  test("an INDIVISIBLE refusal is reported, not retried forever", async () => {
    // Budget below even a single leaf: the split bottoms out and the run has to
    // say so. A prober that silently gave up here would report a clean sweep.
    const probe = refusingOver(0, "subnets", { total: 1 });
    const report = await checkNullability(openapi, probe.fetch);
    assert.ok(
      report.skipped.some(
        (s) => s.startsWith("subnets --") && /complexity/.test(s),
      ),
      `expected subnets to be reported: ${report.skipped.slice(0, 3).join("; ")}`,
    );
  });
});
