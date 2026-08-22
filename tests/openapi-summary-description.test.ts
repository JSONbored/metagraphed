// #11592: the published spec has to describe itself the way OpenAPI defines
// the fields, not the way this contract happened to grow.
//
// `summary` is "a short summary"; clients render it as a one-line label in a
// collapsed operation list. `description` is "a verbose explanation". This
// contract emitted the prose as `summary` from the day it was written, so 254
// of 296 operations carried a label over 63 characters -- median 382, longest
// 3,122 -- and `description` was empty on 217 of them.
//
// The bound is 63 rather than a round number because that is what the Solana
// Foundation's `pay catalog check` enforces on a published catalogue entry,
// and its reasoning generalises: a label is truncated by whatever renders it.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  API_ROUTES,
  FEED_ROUTES,
  OPERATION_SUMMARIES,
  SHARED_PATH_PARAMETER_DESCRIPTIONS,
  SHARED_PATH_PARAMETER_EXAMPLES,
  SHARED_QUERY_PARAMETER_DESCRIPTIONS,
  withSharedPathParameterDescription,
} from "../src/contracts.ts";
import type { Row } from "./row-type.ts";

const MAX_SUMMARY = 63;
const METHODS = ["get", "post", "put", "patch", "delete"];

/**
 * The PUBLISHED document, not a re-derivation of it.
 *
 * `buildOpenApiArtifact` would need the canonical component schemas passed
 * in, and re-deriving would only prove the builder agrees with itself. This
 * file is what consumers actually fetch, and `validate:contract-drift`
 * already guarantees it matches source -- so asserting on it covers both the
 * emit logic and the commit.
 */
/** The published document, parsed once per call site that needs it. */
function doc(): { paths: Record<string, Row> } {
  return JSON.parse(
    readFileSync(
      new URL("../public/metagraph/openapi.json", import.meta.url),
      "utf8",
    ),
  ) as { paths: Record<string, Row> };
}

function operations(): Array<{ path: string; method: string; op: Row }> {
  const doc = JSON.parse(
    readFileSync(
      new URL("../public/metagraph/openapi.json", import.meta.url),
      "utf8",
    ),
  ) as { paths: Record<string, Row> };
  const out: Array<{ path: string; method: string; op: Row }> = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (METHODS.includes(method)) {
        out.push({ path, method, op: op as Row });
      }
    }
  }
  return out;
}

describe("the published OpenAPI document", () => {
  const ops = operations();

  test("has operations at all, so every assertion below can fail", () => {
    // A positive control. Each check below is a `for` over this list, and a
    // `for` over nothing passes.
    assert.ok(ops.length > 250, `only ${ops.length} operations found`);
  });

  test("puts the prose in `description` on EVERY operation", () => {
    const missing = ops.filter(({ op }) => !op.description);
    assert.deepEqual(
      missing.map((m) => `${m.method} ${m.path}`),
      [],
      "an operation with no description publishes no explanation at all",
    );
  });

  test("never publishes a `summary` longer than a label", () => {
    const long = ops
      .filter(({ op }) => typeof op.summary === "string")
      .filter(({ op }) => String(op.summary).length > MAX_SUMMARY)
      .map(
        ({ method, path, op }) =>
          `${method} ${path} (${String(op.summary).length})`,
      );
    assert.deepEqual(long, [], "these belong in `description`");
  });

  test("describes every parameter it publishes", () => {
    // An agent cannot know what to send for a parameter with no description,
    // no enum, no format and no pattern. There were 216 such parameters.
    const undescribed: string[] = [];
    for (const { path, method, op } of ops) {
      for (const parameter of (op.parameters as Row[] | undefined) ?? []) {
        const schema = (parameter.schema ?? {}) as Row;
        const documented =
          parameter.description ||
          schema.description ||
          schema.enum ||
          schema.format ||
          schema.pattern ||
          parameter.example !== undefined;
        if (!documented) {
          undescribed.push(
            `${method} ${path} ${parameter.in}.${parameter.name}`,
          );
        }
      }
    }
    assert.deepEqual(undescribed, []);
  });
});

describe("OPERATION_SUMMARIES", () => {
  test("names only routes that exist", () => {
    // A key that matches no route is silently inert -- it reads as a
    // documented route and publishes nothing. That is the failure mode a
    // declared list has, and the reason this test exists rather than a
    // comment asking people to be careful.
    const ids = new Set(API_ROUTES.map((entry) => entry.id));
    const unknown = Object.keys(OPERATION_SUMMARIES).filter(
      (id) => !ids.has(id),
    );
    assert.deepEqual(unknown, []);
  });

  test("is short enough to be a label", () => {
    const long = Object.entries(OPERATION_SUMMARIES)
      .filter(([, summary]) => summary.length > MAX_SUMMARY)
      .map(([id, summary]) => `${id} (${summary.length})`);
    assert.deepEqual(long, []);
  });

  test("opens with an action verb", () => {
    // A label a reader scans should say what the call DOES.
    // `pay catalog check` warns on a noun-phrase opener, naming `Search`,
    // `Create`, `Fetch` and `Generate` as examples; `List` is accepted too.
    // `Ask` is NOT recognised by it, which is why /api/v1/ask leads with
    // `Generate` and says what it generates rather than arguing the point.
    const VERBS =
      /^(List|Fetch|Search|Create|Generate|Update|Delete|Read|Run|Query)\b/;
    const nounPhrases = Object.entries(OPERATION_SUMMARIES)
      .filter(([, summary]) => !VERBS.test(summary))
      .map(([id, summary]) => `${id}: "${summary}"`);
    assert.deepEqual(nounPhrases, []);
  });

  test("actually reaches the document", () => {
    // The table and the emitter are separate; this proves they are connected,
    // rather than that the table is well-formed in isolation.
    const byId = new Map(
      operations().map(({ op }) => [String(op.operationId), op]),
    );
    const published = [...byId.values()].filter((op) => op.summary).length;
    assert.ok(published > 0, "no summary reached the document");
  });
});

describe("SHARED_PATH_PARAMETER_DESCRIPTIONS", () => {
  test("covers every path parameter the contract declares", () => {
    // The table is keyed by name and applied at emit time, so a path
    // parameter introduced with a new name gets no description unless it is
    // added here -- which is exactly the regression this catches.
    const declared = new Set<string>();
    // FEED_ROUTES too: they run through the same emit-time helper, and
    // checking only API_ROUTES would leave a feed path parameter undescribed
    // while this test passed.
    for (const entry of [...API_ROUTES, ...FEED_ROUTES]) {
      for (const parameter of (entry.path_parameters ?? []) as Row[]) {
        if (!parameter.description) declared.add(String(parameter.name));
      }
    }
    const uncovered = [...declared].filter(
      (name) => !SHARED_PATH_PARAMETER_DESCRIPTIONS[name],
    );
    assert.deepEqual(uncovered, []);
  });
});

describe("withSharedPathParameterDescription", () => {
  test("fills a known name", () => {
    const filled = withSharedPathParameterDescription({
      name: "netuid",
    }) as Row;
    assert.equal(filled.description, SHARED_PATH_PARAMETER_DESCRIPTIONS.netuid);
  });

  test("leaves an unknown name ALONE rather than describing it wrongly", () => {
    // The arm no current route reaches, and the one that decides what happens
    // to the next parameter name somebody adds. Silence beats a sentence
    // invented for a parameter nobody documented.
    const untouched = { name: "not_in_the_table" };
    assert.equal(withSharedPathParameterDescription(untouched), untouched);
  });

  test("never overrides prose written at the call site", () => {
    const inline = { name: "netuid", description: "Something route-specific." };
    assert.equal(withSharedPathParameterDescription(inline), inline);
  });

  test("ignores a parameter with no name", () => {
    const nameless = { schema: { type: "string" } };
    assert.equal(withSharedPathParameterDescription(nameless), nameless);
  });
});

describe("the derived query descriptions stay grammatical without a schema", () => {
  // Both read a bound off the parameter's own schema and fall back when it is
  // absent. The fallback is what a route publishes if it ever stops declaring
  // one, and a sentence ending in " (1-" would ship silently.
  test("`blocks` without a maximum", () => {
    const text = SHARED_QUERY_PARAMETER_DESCRIPTIONS.blocks!({});
    assert.match(text, /aggregate over\.$/);
  });

  test("`days` without a default", () => {
    const text = SHARED_QUERY_PARAMETER_DESCRIPTIONS.days!({});
    assert.match(text, /history to return\.$/);
  });
});

describe("SHARED_PATH_PARAMETER_EXAMPLES", () => {
  test("every example names a parameter that is also described", () => {
    // An example for a parameter nothing declares is inert -- it reads as
    // coverage and publishes nothing, the same failure the key check above
    // exists for.
    const undescribed = Object.keys(SHARED_PATH_PARAMETER_EXAMPLES).filter(
      (name) => !SHARED_PATH_PARAMETER_DESCRIPTIONS[name],
    );
    assert.deepEqual(undescribed, []);
  });

  test("examples reach the published document", () => {
    const netuid = (
      (doc().paths["/api/v1/subnets/{netuid}"]!.get as Row).parameters as Row[]
    ).find((p) => p.name === "netuid");
    assert.equal(netuid?.example, SHARED_PATH_PARAMETER_EXAMPLES.netuid);
  });

  test("no example is given for a value that goes stale", () => {
    // A concrete block number or extrinsic hash starts 404ing weeks after it
    // is written, which is worse than publishing none. Pinned so a future
    // "let's be thorough" pass does not add one.
    for (const unstable of ["ref", "hash", "date", "crowdloan_id"]) {
      assert.equal(
        SHARED_PATH_PARAMETER_EXAMPLES[unstable],
        undefined,
        `${unstable} is not stable enough to publish an example for`,
      );
    }
  });
});
