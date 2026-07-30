// Worker-side loader for #8704's subnet news.
//
// The stub DISPATCHES ON PATH and fails an unexpected one. That is the whole
// point here: #8242/#8353 both shipped because a forwarded request hit a path
// DATA_API has no route for and degraded silently to empty — indistinguishable
// from "this subnet has no news". A path-blind stub would reproduce exactly
// that blindness in the test.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { mockEnv } from "./row-type.ts";

const HYPERPARAMS = {
  entries: [
    {
      block_number: 8700000,
      observed_at: "2026-07-25T10:00:00.000Z",
      hyperparameters: { tempo: 720, registration_allowed: true },
    },
    {
      block_number: 8611693,
      observed_at: "2026-07-13T09:48:49.763Z",
      hyperparameters: { tempo: 360, registration_allowed: true },
    },
  ],
};

const OWNERSHIP = {
  ownership_changes: [
    {
      block_number: 8724813,
      event_index: 137,
      method: "SubnetOwnerChanged",
      args: {
        netuid: [18],
        old_coldkey: "5DHwWLjtpwnZQUQKKXE2N5Gdy2N8PpqhgjLUuzgSB7yuGZkF",
        new_coldkey: "5GgvCi6h7dNsC489T8UnUMv912SoEXpEUDVt71VJU1Td7WKh",
      },
      extrinsic_index: null,
      observed_at: 1785294096000,
    },
  ],
};

function dataApiEnv(routes: Record<string, unknown>, seen: string[] = []) {
  return mockEnv({
    DATA_API: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        seen.push(path);
        if (!(path in routes)) {
          throw new Error(`unstubbed DATA_API path: ${path}`);
        }
        const body = routes[path];
        if (body === null) return new Response("", { status: 500 });
        return Response.json(body);
      },
    },
  });
}

describe("resolveSubnetNewsForFeed", () => {
  test("asks the three upstream paths by name and builds items", async () => {
    const { resolveSubnetNewsForFeed } = await import("../workers/api.ts");
    const seen: string[] = [];
    const env = dataApiEnv(
      {
        "/api/v1/subnets/18/hyperparameters/history": HYPERPARAMS,
        "/api/v1/subnets/18/ownership-history": OWNERSHIP,
        "/api/v1/subnets/18/lease/history": { lease_events: [] },
      },
      seen,
    );
    const items = await resolveSubnetNewsForFeed(env as never, 18);
    assert.deepEqual(seen.sort(), [
      "/api/v1/subnets/18/hyperparameters/history",
      "/api/v1/subnets/18/lease/history",
      "/api/v1/subnets/18/ownership-history",
    ]);
    assert.ok(items.some((i) => i.id.startsWith("chain:sn18:owner:")));
    assert.ok(items.some((i) => i.id.includes(":hyperparam:")));
  });

  test("sorts the newest-first hyperparameter tier into ascending order", async () => {
    // The tier returns newest-first; the differ compares each row against the
    // one BEFORE it in time, so an unsorted feed would report 720 -> 360.
    const { resolveSubnetNewsForFeed } = await import("../workers/api.ts");
    const env = dataApiEnv({
      "/api/v1/subnets/18/hyperparameters/history": HYPERPARAMS,
      "/api/v1/subnets/18/ownership-history": { ownership_changes: [] },
      "/api/v1/subnets/18/lease/history": { lease_events: [] },
    });
    const items = await resolveSubnetNewsForFeed(env as never, 18);
    const tempo = items.find((i) => i.id.endsWith(":tempo"));
    assert.equal(tempo?.title, "Subnet 18: Tempo 360 → 720");
  });

  test("one failing tier costs only its own items", async () => {
    const { resolveSubnetNewsForFeed } = await import("../workers/api.ts");
    const env = dataApiEnv({
      "/api/v1/subnets/18/hyperparameters/history": null,
      "/api/v1/subnets/18/ownership-history": OWNERSHIP,
      "/api/v1/subnets/18/lease/history": { lease_events: [] },
    });
    const items = await resolveSubnetNewsForFeed(env as never, 18);
    assert.ok(items.some((i) => i.id.startsWith("chain:sn18:owner:")));
    assert.ok(!items.some((i) => i.id.includes(":hyperparam:")));
  });

  test("turns the record's github_releases into release items", async () => {
    // #8704 part 2: releases ride on the subnet's served record, captured by
    // scripts/github-signals.ts — no GitHub call from the request path.
    const { resolveSubnetNewsForFeed } = await import("../workers/api.ts");
    const env = dataApiEnv({
      "/api/v1/subnets/18/hyperparameters/history": { entries: [] },
      "/api/v1/subnets/18/ownership-history": { ownership_changes: [] },
      "/api/v1/subnets/18/lease/history": { lease_events: [] },
    });
    const items = await resolveSubnetNewsForFeed(env as never, 18, {
      readArtifact: async (_env: unknown, path: string) => {
        assert.equal(path, "/metagraph/subnets/18.json");
        return {
          ok: true,
          data: {
            netuid: 18,
            github_releases: [
              {
                tag: "v3.0.6",
                name: "v3.0.6",
                published_at: "2025-09-11T00:00:30Z",
                url: "https://github.com/macrocosm-os/apex/releases/tag/v3.0.6",
                prerelease: false,
              },
            ],
          },
        };
      },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "chain:sn18:release:v3.0.6");
    // The captured html_url points at the RENAMED repo (prompting -> apex).
    assert.equal(
      items[0].url,
      "https://github.com/macrocosm-os/apex/releases/tag/v3.0.6",
    );
  });

  test("a record without github_releases yields no release items", async () => {
    const { resolveSubnetNewsForFeed } = await import("../workers/api.ts");
    const env = dataApiEnv({
      "/api/v1/subnets/18/hyperparameters/history": { entries: [] },
      "/api/v1/subnets/18/ownership-history": { ownership_changes: [] },
      "/api/v1/subnets/18/lease/history": { lease_events: [] },
    });
    assert.deepEqual(
      await resolveSubnetNewsForFeed(env as never, 18, {
        readArtifact: async () => ({ ok: true, data: { netuid: 18 } }),
      }),
      [],
    );
  });

  test("an unreadable record costs only the release items", async () => {
    const { resolveSubnetNewsForFeed } = await import("../workers/api.ts");
    const env = dataApiEnv({
      "/api/v1/subnets/18/hyperparameters/history": { entries: [] },
      "/api/v1/subnets/18/ownership-history": OWNERSHIP,
      "/api/v1/subnets/18/lease/history": { lease_events: [] },
    });
    for (const read of [
      async () => {
        throw new Error("r2 down");
      },
      async () => ({ ok: false }),
    ]) {
      const items = await resolveSubnetNewsForFeed(env as never, 18, {
        readArtifact: read as never,
      });
      assert.ok(items.some((i) => i.id.startsWith("chain:sn18:owner:")));
      assert.ok(!items.some((i) => i.id.includes(":release:")));
    }
  });

  test("no DATA_API binding yields no items rather than throwing", async () => {
    const { resolveSubnetNewsForFeed } = await import("../workers/api.ts");
    assert.deepEqual(
      await resolveSubnetNewsForFeed(mockEnv() as never, 18),
      [],
    );
  });

  test("rejects a non-netuid without calling anything", async () => {
    const { resolveSubnetNewsForFeed } = await import("../workers/api.ts");
    const seen: string[] = [];
    const env = dataApiEnv({}, seen);
    for (const netuid of [-1, 1.5, Number.NaN]) {
      assert.deepEqual(
        await resolveSubnetNewsForFeed(env as never, netuid),
        [],
      );
    }
    assert.deepEqual(seen, []);
  });
});
