// The registry writer's cursor, which is the part that can lose history.
//
// #9779: workers/registry-sync-api.ts called itself the ONLY write path into
// the registry database and nothing called it, so surface_history froze on
// 2026-08-02. This lane is the replacement, and the assertions below are all
// about the ONE property that matters -- the cursor must never advance past
// work that did not land, because a skipped range is a permanent hole in an
// append-only audit trail rather than a delay.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  REGISTRY_SYNC_LANE,
  runRegistrySyncLane,
} from "../src/registry-sync-lane.ts";
import {
  buildRegistrySyncPayload,
  isEmptyPayload,
  isRegistryPath,
} from "../src/registry-sync-payload.ts";

function kv(initial: string | null = null) {
  let value = initial;
  return {
    get: async () => value,
    put: async (_k: string, v: string) => {
      value = v;
    },
    read: () => value,
  };
}

const OK_API = {
  fetch: async () =>
    new Response(JSON.stringify({ subnets_written: 1 }), { status: 200 }),
};

describe("the lane refuses to run without its dependencies", () => {
  test("no KV means no cursor, so no tick", async () => {
    const r = await runRegistrySyncLane(
      { REGISTRY_SYNC_SECRET: "s" },
      { kv: null, registrySyncApi: OK_API },
    );
    assert.equal(r.ok, false);
    assert.match(r.reason!, /kv/i);
  });

  test("no service binding means the write has nowhere to go", async () => {
    const r = await runRegistrySyncLane(
      { REGISTRY_SYNC_SECRET: "s" },
      { kv: kv(), registrySyncApi: null },
    );
    assert.equal(r.ok, false);
    assert.match(r.reason!, /registry-sync binding/i);
  });

  test("an unprovisioned secret is reported, not sent as undefined", async () => {
    // The sync route's shared-secret gate is the ONLY auth on that path.
    // Posting without one would be rejected there, but reporting it here says
    // which side is unconfigured.
    const r = await runRegistrySyncLane(
      {},
      { kv: kv(), registrySyncApi: OK_API },
    );
    assert.equal(r.ok, false);
    assert.match(r.reason!, /secret/i);
  });
});

describe("isRegistryPath", () => {
  test("accepts the two registry directories and nothing else", () => {
    assert.equal(isRegistryPath("registry/subnets/apex.json"), true);
    assert.equal(isRegistryPath("registry/providers/foo.json"), true);
    assert.equal(isRegistryPath("registry/subnets/nested/apex.json"), false);
    assert.equal(isRegistryPath("registry/schema.json"), false);
    assert.equal(isRegistryPath("src/index.ts"), false);
    // A path that merely CONTAINS the prefix must not match -- the sync would
    // otherwise try to parse an unrelated file as an overlay.
    assert.equal(isRegistryPath("docs/registry/subnets/apex.json"), false);
  });
});

describe("buildRegistrySyncPayload", () => {
  const SUBNET = {
    netuid: 7,
    slug: "apex",
    name: "Apex",
    surfaces: [
      { kind: "api", url: "https://example.com/api", public_safe: true },
    ],
  };

  test("a subnet file yields its row, its surfaces and its prune", () => {
    const p = buildRegistrySyncPayload(
      [{ path: "registry/subnets/apex.json", overlay: SUBNET }],
      "abc123",
    );
    assert.equal(p.subnets.length, 1);
    assert.equal(p.surfaces.length, 1);
    assert.equal(p.prune_surfaces.length, 1);
    assert.equal(p.subnets[0]!.source_commit, "abc123");
    // The prune is scoped, or it would delete machine-discovered surfaces this
    // payload has no way to know about.
    assert.equal(p.prune_surfaces[0]!.authority_scope, "community");
    // The surface array is stripped from the subnet overlay -- it is stored as
    // rows, not as a blob inside the parent.
    assert.equal(p.subnets[0]!.overlay.surfaces, undefined);
  });

  test("a surface carries a real derived key, not a placeholder", () => {
    const p = buildRegistrySyncPayload(
      [{ path: "registry/subnets/apex.json", overlay: SUBNET }],
      "abc123",
    );
    assert.equal(p.surfaces[0]!.surface_key, "7|api|https://example.com/api");
  });

  test("a removed subnet file becomes a delete", () => {
    const p = buildRegistrySyncPayload(
      [
        {
          path: "registry/subnets/gone.json",
          overlay: null,
          deletedNetuid: 42,
        },
      ],
      "abc123",
    );
    assert.deepEqual(p.delete_subnets, [
      { netuid: 42, source_commit: "abc123" },
    ]);
  });

  test("A RENAME MUST NOT DELETE THE SUBNET", () => {
    // The failure this guard exists for. A rename is one removed path and one
    // added path for the SAME netuid. Emitting the delete would drop the
    // subnet and everything referencing it, and the upsert in the same request
    // would not bring the surfaces back.
    const p = buildRegistrySyncPayload(
      [
        { path: "registry/subnets/old.json", overlay: null, deletedNetuid: 7 },
        { path: "registry/subnets/new.json", overlay: SUBNET },
      ],
      "abc123",
    );
    assert.deepEqual(p.delete_subnets, []);
    assert.equal(p.subnets.length, 1);
  });

  test("a malformed overlay is skipped rather than written with holes", () => {
    const p = buildRegistrySyncPayload(
      [
        { path: "registry/subnets/bad.json", overlay: { slug: "x" } },
        { path: "registry/providers/bad.json", overlay: { name: "no id" } },
      ],
      "abc123",
    );
    assert.equal(p.subnets.length, 0);
    assert.equal(p.providers.length, 0);
    assert.equal(isEmptyPayload(p), true);
  });

  test("an empty payload is recognisable, so no no-op request is sent", () => {
    assert.equal(isEmptyPayload(buildRegistrySyncPayload([], "abc")), true);
    assert.equal(
      isEmptyPayload(
        buildRegistrySyncPayload(
          [{ path: "registry/subnets/apex.json", overlay: SUBNET }],
          "abc",
        ),
      ),
      false,
    );
  });
});

describe("the cursor", () => {
  /** Stubs the GitHub calls the lane makes, in the order it makes them. */
  function stubGitHub(opts: {
    head: string;
    files?: { filename: string; status?: string }[];
    contents?: Record<string, unknown>;
  }) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/commits/main"))
        return new Response(JSON.stringify({ sha: opts.head }));
      if (url.includes("/compare/"))
        return new Response(JSON.stringify({ files: opts.files ?? [] }));
      if (url.includes("/contents/")) {
        const path = decodeURIComponent(
          url.split("/contents/")[1]!.split("?")[0]!,
        );
        const overlay = opts.contents?.[path];
        if (!overlay) return new Response("no", { status: 404 });
        return new Response(
          JSON.stringify({ content: btoa(JSON.stringify(overlay)) }),
        );
      }
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  const ENV = { REGISTRY_SYNC_SECRET: "s", GITHUB_TOKEN: "t" };

  test("the FIRST run records the head and syncs nothing", async () => {
    // There is no honest base to compare against. Picking one would either
    // resync the whole registry or silently skip everything before it; taking
    // the head costs one merge of latency, once, and cannot be wrong.
    const restore = stubGitHub({ head: "head1" });
    try {
      const store = kv(null);
      const r = await runRegistrySyncLane(ENV, {
        kv: store,
        registrySyncApi: OK_API,
      });
      assert.equal(r.ok, true);
      assert.match(r.reason!, /initialised/);
      assert.equal(store.read(), "head1");
    } finally {
      restore();
    }
  });

  test("an unchanged head costs ONE request and moves nothing", async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ sha: "same" }));
    }) as typeof fetch;
    try {
      const store = kv("same");
      const r = await runRegistrySyncLane(ENV, {
        kv: store,
        registrySyncApi: OK_API,
      });
      assert.equal(r.ok, true);
      assert.match(r.reason!, /no new commits/);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("THE CURSOR DOES NOT ADVANCE WHEN THE SYNC IS REJECTED", async () => {
    // The property this lane lives or dies on. Advancing past a failed POST
    // turns one bad request into a permanent hole in surface_history -- which
    // is the exact failure #9779 is about. The next tick must retry the same
    // range.
    const restore = stubGitHub({
      head: "head2",
      files: [{ filename: "registry/subnets/apex.json" }],
      contents: {
        "registry/subnets/apex.json": {
          netuid: 7,
          slug: "apex",
          name: "Apex",
          surfaces: [],
        },
      },
    });
    try {
      const store = kv("base1");
      const r = await runRegistrySyncLane(ENV, {
        kv: store,
        registrySyncApi: {
          fetch: async () => new Response("nope", { status: 502 }),
        },
      });
      assert.equal(r.ok, false);
      assert.match(r.reason!, /rejected/);
      assert.equal(store.read(), "base1", "cursor moved past a failed write");
    } finally {
      restore();
    }
  });

  test("the cursor advances when the sync succeeds", async () => {
    const restore = stubGitHub({
      head: "head3",
      files: [{ filename: "registry/subnets/apex.json" }],
      contents: {
        "registry/subnets/apex.json": {
          netuid: 7,
          slug: "apex",
          name: "Apex",
          surfaces: [],
        },
      },
    });
    try {
      const store = kv("base1");
      const r = await runRegistrySyncLane(ENV, {
        kv: store,
        registrySyncApi: OK_API,
      });
      assert.equal(r.ok, true);
      assert.equal(store.read(), "head3");
      assert.equal(r.files, 1);
    } finally {
      restore();
    }
  });

  test("a commit touching no registry file still advances the cursor", async () => {
    // Otherwise every unrelated merge would be re-diffed forever and the range
    // would grow without bound.
    const restore = stubGitHub({
      head: "head4",
      files: [{ filename: "src/index.ts" }],
    });
    try {
      const store = kv("base1");
      const r = await runRegistrySyncLane(ENV, {
        kv: store,
        registrySyncApi: OK_API,
      });
      assert.equal(r.ok, true);
      assert.equal(store.read(), "head4");
    } finally {
      restore();
    }
  });

  test("an unreachable GitHub leaves the cursor alone", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;
    try {
      const store = kv("base1");
      const r = await runRegistrySyncLane(ENV, {
        kv: store,
        registrySyncApi: OK_API,
      });
      assert.equal(r.ok, false);
      assert.equal(store.read(), "base1");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("the lane records a durable verdict", () => {
  /** A lane_health double that captures what was written. */
  function laneDb() {
    const rows: Record<string, unknown>[] = [];
    return {
      rows,
      db: {
        query: async () => [],
        run: async (_sql: string, v: unknown[] = []) => {
          rows.push({ v });
          return { changes: 1 };
        },
      } as never,
    };
  }

  test("a tick that could not run is stale, not silent", async () => {
    // The failure mode this exists for. The lane it replaces reported nothing
    // at all, which is why nobody noticed surface_history had frozen: an
    // outcome that lives only in a returned object is an outcome nothing
    // watches.
    const sink = laneDb();
    const r = await runRegistrySyncLane(
      {},
      { kv: kv(), registrySyncApi: OK_API, laneHealthDb: sink.db },
    );
    assert.equal(r.ok, false);
    // Asserted on CONTENT, not on a row count: recordLaneVerdict also prunes
    // the retention window, so it binds more than once per verdict.
    const written = JSON.stringify(sink.rows);
    assert.ok(written.includes(REGISTRY_SYNC_LANE));
    assert.ok(
      written.includes("stale"),
      "a tick that could not run must record stale",
    );
  });

  test('"no new commits" is ok — the lane did its job by looking', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ sha: "same" }))) as typeof fetch;
    try {
      const sink = laneDb();
      const r = await runRegistrySyncLane(
        { REGISTRY_SYNC_SECRET: "s" },
        { kv: kv("same"), registrySyncApi: OK_API, laneHealthDb: sink.db },
      );
      assert.equal(r.ok, true);
      const written = JSON.stringify(sink.rows);
      assert.ok(written.includes(REGISTRY_SYNC_LANE));
      assert.ok(written.includes("no new commits"));
      // Emphatically NOT stale: an idle tick is the common case, and a lane
      // that cried stale four times an hour would train everyone to ignore it.
      assert.ok(!written.includes("stale"));
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a rejected sync records the reason, not just a boolean", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/commits/main"))
        return new Response(JSON.stringify({ sha: "h" }));
      if (url.includes("/compare/"))
        return new Response(
          JSON.stringify({ files: [{ filename: "registry/subnets/a.json" }] }),
        );
      return new Response(
        JSON.stringify({
          content: btoa(
            JSON.stringify({ netuid: 1, slug: "a", name: "A", surfaces: [] }),
          ),
        }),
      );
    }) as typeof fetch;
    try {
      const sink = laneDb();
      await runRegistrySyncLane(
        { REGISTRY_SYNC_SECRET: "s" },
        {
          kv: kv("base"),
          registrySyncApi: {
            fetch: async () => new Response("no", { status: 502 }),
          },
          laneHealthDb: sink.db,
        },
      );
      const written = JSON.stringify(sink.rows);
      assert.ok(written.includes("rejected"));
      assert.ok(written.includes("502"), "the status belongs in the detail");
    } finally {
      globalThis.fetch = original;
    }
  });
});
