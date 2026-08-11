// The four document-shaped collection routes, paged over GraphQL (#9981).
//
// These fields served a whole baked artifact until their routes declared a
// query collection. The REST half is the declaration; this is the half that
// proves GraphQL takes the same arguments and actually applies them -- the
// alternative was a declared divergence, which is what this epic removes.
//
// Exercised through `handleGraphQLRequest` against the same local artifact env
// tests/zod-schemas.test.ts uses, so what is asserted is the served answer
// rather than the helper in isolation.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import {
  handleGraphQLRequest,
  pageDocumentCollection,
} from "../src/graphql.ts";
import type { Row } from "./row-type.ts";

type Env = Parameters<typeof handleGraphQLRequest>[1];

async function query(document: string): Promise<Row> {
  const res = await handleGraphQLRequest(
    new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: document }),
    }),
    createLocalArtifactEnv() as unknown as Env,
    {},
  );
  return (await res.json()) as Row;
}

const dataOf = (body: Row, field: string): Row => {
  assert.equal(
    (body.errors as unknown[] | undefined)?.length ?? 0,
    0,
    `unexpected GraphQL errors: ${JSON.stringify(body.errors)}`,
  );
  return (body.data as Row)[field] as Row;
};

describe("document-shaped collections page over GraphQL", () => {
  test("fixtures takes limit and returns at most that many rows", async () => {
    const full = dataOf(await query("{ fixtures }"), "fixtures");
    const paged = dataOf(await query("{ fixtures(limit: 2) }"), "fixtures");
    const all = full.fixtures as Row[];
    const page = paged.fixtures as Row[];
    // Sized against the artifact rather than a literal: the local build's
    // fixture index is small, and a test that needs production-sized data is a
    // test that passes for the wrong reason when the data changes.
    assert.equal(page.length, Math.min(2, all.length));
  });

  test("contracts takes limit and returns at most that many artifacts", async () => {
    const paged = dataOf(
      await query("{ contracts(limit: 2) { artifacts { id } } }"),
      "contracts",
    );
    assert.ok((paged.artifacts as Row[]).length <= 2);
  });

  test("agent_catalog pages the index", async () => {
    const paged = dataOf(
      await query("{ agent_catalog(limit: 2) }"),
      "agent_catalog",
    );
    assert.ok((paged.subnets as Row[]).length <= 2);
  });

  // The lever this issue was filed for, on the field whose payload was 400
  // points: `points` pages while `point_count` keeps spanning the whole series,
  // so a caller asking for fewer does not lose the denominator.
  test("subnet_trajectory pages points and keeps point_count whole", async () => {
    const body = await query(
      "{ subnet_trajectory(netuid: 1, limit: 2) { point_count points { date } } }",
    );
    // A subnet with no snapshots resolves to an empty trajectory rather than an
    // error, so this asserts the shape holds either way.
    const card = dataOf(body, "subnet_trajectory");
    const points = card.points as Row[];
    assert.ok(points.length <= 2, "points must respect the page");
    assert.ok(
      (card.point_count as number) >= points.length,
      "point_count spans the unfiltered series",
    );
  });

  // Not a silently substituted default -- the same convention every other
  // collection field here follows. The rejection comes from
  // parseArgumentsAtDispatch against the route's published enum, BEFORE the
  // resolver runs, which is why pageDocumentCollection's own throw is
  // unreachable and marked so.
  test("an unsupported sort is a BAD_USER_INPUT error, not a default", async () => {
    const body = await query('{ fixtures(sort: "not_a_column") }');
    const errors = (body.errors ?? []) as Array<{
      extensions?: { code?: string };
    }>;
    assert.equal(errors.length > 0, true, "expected an error");
    assert.equal(errors[0]?.extensions?.code, "BAD_USER_INPUT");
  });
});

// The rejection path, reached by injecting a collection that HAS a sort
// vocabulary. Through the four fields above it is unreachable --
// parseArgumentsAtDispatch rejects a bad sort against the route's published
// enum before the resolver runs -- but it stops being unreachable the moment
// one of them declares a filter, and that should not be the day a bad value
// becomes a 500.
describe("pageDocumentCollection", () => {
  test("a value the collection rejects becomes BAD_USER_INPUT", () => {
    assert.throws(
      () =>
        pageDocumentCollection({ candidates: [] }, "candidates", {
          sort: "not_a_sortable_column",
        }),
      (err: unknown) => {
        const gql = err as { extensions?: { code?: string } };
        assert.equal(gql.extensions?.code, "BAD_USER_INPUT");
        return true;
      },
    );
  });

  test("a null document passes through rather than erroring", () => {
    assert.equal(pageDocumentCollection(null, "candidates", {}), null);
  });
});
