import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  parseAskedPairs,
  plannedKindsFor,
  type Row,
} from "../scripts/enrichment-planner.ts";

const KIND_LABEL: Record<string, string> = {
  openapi: "OpenAPI/Swagger spec",
  "subnet-api": "public API endpoint",
  "data-artifact": "public data artifact",
  sse: "SSE stream",
};
const KINDS = ["openapi", "subnet-api", "data-artifact", "sse"];
const VALUE_PRIORITY = ["subnet-api", "openapi", "data-artifact", "sse"];

describe("enrichment dedup across ALL issue states (#8676)", () => {
  // The loop this fixes: dedup read `--state open` only, so closing an Enrich
  // issue made it eligible for recreation. "Enrich SN51 lium.io — add SSE
  // stream" was filed four times — #5179, #6653, #7615, #8662 — once a week,
  // each time a maintainer closed the last one.
  test("a CLOSED issue still counts as asked", () => {
    const asked = parseAskedPairs(
      ["Enrich SN51 lium\\.io — add SSE stream"],
      KIND_LABEL,
    );
    assert.ok(asked.has("51:sse"));
  });

  test("closing one kind does not suppress a different kind for the same subnet", () => {
    // A maintainer answering "SN51 has no SSE" must not also silence a future
    // "SN51 — add OpenAPI spec" once an OpenAPI candidate appears.
    const asked = parseAskedPairs(
      ["Enrich SN51 lium\\.io — add SSE stream"],
      KIND_LABEL,
    );
    assert.ok(asked.has("51:sse"));
    assert.ok(!asked.has("51:openapi"));
  });

  test("reads both kinds out of a two-kind title", () => {
    const asked = parseAskedPairs(
      ["Enrich SN48 Quantum — add public API endpoint + OpenAPI/Swagger spec"],
      KIND_LABEL,
    );
    assert.ok(asked.has("48:subnet-api"));
    assert.ok(asked.has("48:openapi"));
  });

  test("ignores titles that are not enrichment issues", () => {
    assert.equal(
      parseAskedPairs(["Enrich the docs with an SSE stream guide"], KIND_LABEL)
        .size,
      0,
    );
  });
});

describe("enrichment evidence gate (#8676)", () => {
  const entry = (over: Row = {}): Row => ({
    netuid: 51,
    missing_kinds: ["openapi", "sse"],
    candidate_evidence_summary: { kinds_with_candidates: ["openapi"] },
    direct_submission_kinds: [],
    ...over,
  });

  test("asks only for kinds discovery actually found a candidate for", () => {
    // 124 of 129 subnets are "missing" sse because most simply do not publish
    // an event stream. Without this gate that gap is permanently true, so the
    // queue can never drain and the issue is unclosable by doing the work.
    assert.deepEqual(
      plannedKindsFor(entry(), KINDS, new Set(), VALUE_PRIORITY),
      ["openapi"],
    );
  });

  test("direct_submission_kinds also counts as evidence", () => {
    assert.deepEqual(
      plannedKindsFor(
        entry({
          candidate_evidence_summary: { kinds_with_candidates: [] },
          direct_submission_kinds: ["sse"],
        }),
        KINDS,
        new Set(),
        VALUE_PRIORITY,
      ),
      ["sse"],
    );
  });

  test("no evidence for any missing kind means no issue at all", () => {
    assert.deepEqual(
      plannedKindsFor(
        entry({ candidate_evidence_summary: { kinds_with_candidates: [] } }),
        KINDS,
        new Set(),
        VALUE_PRIORITY,
      ),
      [],
    );
  });

  test("an already-asked pair is excluded even with evidence", () => {
    assert.deepEqual(
      plannedKindsFor(entry(), KINDS, new Set(["51:openapi"]), VALUE_PRIORITY),
      [],
    );
  });

  test("orders by agent value — a callable API before its spec", () => {
    assert.deepEqual(
      plannedKindsFor(
        entry({
          missing_kinds: ["openapi", "subnet-api"],
          candidate_evidence_summary: {
            kinds_with_candidates: ["openapi", "subnet-api"],
          },
        }),
        KINDS,
        new Set(),
        VALUE_PRIORITY,
      ),
      ["subnet-api", "openapi"],
    );
  });

  test("a missing entry shape degrades to no issue rather than throwing", () => {
    assert.deepEqual(
      plannedKindsFor({ netuid: 7 }, KINDS, new Set(), VALUE_PRIORITY),
      [],
    );
  });
});

describe("the dedup query actually matches (#8676)", () => {
  test("searches 'Enrich in:title', never 'Enrich SN in:title'", () => {
    // GitHub search drops the bare "SN" token, so the two-word form silently
    // matches NOTHING — verified live: "Enrich in:title" returns 288 titles,
    // "Enrich SN in:title" returns 0. A dedup query that quietly matches
    // nothing is worse than no dedup, because it looks like it works.
    const raw = readFileSync(
      new URL("../scripts/enrichment-issues.ts", import.meta.url),
      "utf8",
    );
    // Strip line comments first: the code deliberately DOCUMENTS the broken
    // query, so a naive source scan would match the explanation rather than
    // the argument.
    const source = raw
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    assert.match(source, /"Enrich in:title"/);
    assert.doesNotMatch(source, /"Enrich SN in:title"/);
    // And it must look at closed issues, which is the whole point.
    assert.match(source, /"--state",\s*\n?\s*"all"/);
    assert.doesNotMatch(source, /"--state",\s*\n?\s*"open"/);
  });
});
