// The registry reconciler's pass, which is the part that can lose or repeat work.
//
// #10236: the incremental lane (src/registry-sync-lane.ts) only ever syncs
// forward from its cursor, and its own comment leans on a "scheduled full
// resync" that was a GitHub Actions script nothing calls. So `subnets`,
// `providers` and `surfaces` sat 145-160h stale while `registry-sync` reported
// `ok: no registry files changed` every tick -- true for the window it looks
// at, and the gap was outside it.
//
// The assertions below are about the four properties that make a paged
// reconciler either self-healing or a new source of damage: the offset must
// not advance past a rejected write, a pass must stay pinned to one commit, a
// finished pass must not immediately restart, and the verdict must carry
// counts so "0 of 3444" cannot read as success.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  REGISTRY_RESYNC_LANE,
  RESYNC_MIN_INTERVAL_MS,
  RESYNC_PAGE_SIZE,
  resyncDetail,
  runRegistryResyncLane,
} from "../src/registry-resync-lane.ts";

/** A KV double that records every key, so state and completion are inspectable. */
function kv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    read: (k: string) => store.get(k) ?? null,
    has: (k: string) => store.has(k),
  };
}

const OK_API = {
  fetch: async () =>
    new Response(JSON.stringify({ subnets_written: 2, surfaces_written: 9 }), {
      status: 200,
    }),
};
const REJECTING_API = {
  fetch: async () => new Response("nope", { status: 500 }),
};

/**
 * A `fetch` double for the GitHub calls the lane makes.
 *
 * `subnets`/`providers` are the file NAMES each directory listing returns; the
 * contents call answers with a base64 overlay for any of them.
 */
function githubFetch({
  head = "aaa",
  subnets = ["one", "two"],
  providers = ["p1"],
  listingFails = false,
}: {
  head?: string;
  subnets?: string[];
  providers?: string[];
  listingFails?: boolean;
} = {}) {
  const calls: string[] = [];
  const overlay = (name: string, netuid: number) =>
    btoa(
      JSON.stringify({
        content: undefined,
        slug: name,
        netuid,
        name,
        surfaces: [],
      }),
    );
  const handler = async (url: string | URL) => {
    const path = String(url);
    calls.push(path);
    if (path.includes("/commits/main")) {
      return new Response(JSON.stringify({ sha: head }), { status: 200 });
    }
    if (path.includes("/contents/registry/subnets?")) {
      if (listingFails) return new Response("no", { status: 404 });
      return new Response(
        JSON.stringify(
          subnets.map((n) => ({
            path: `registry/subnets/${n}.json`,
            type: "file",
          })),
        ),
        { status: 200 },
      );
    }
    if (path.includes("/contents/registry/providers?")) {
      if (listingFails) return new Response("no", { status: 404 });
      return new Response(
        JSON.stringify(
          providers.map((n) => ({
            path: `registry/providers/${n}.json`,
            type: "file",
          })),
        ),
        { status: 200 },
      );
    }
    if (path.includes("/contents/registry/")) {
      const name = path.split("/").pop()!.split(".json")[0]!;
      return new Response(
        JSON.stringify({ content: overlay(name, 1), encoding: "base64" }),
        { status: 200 },
      );
    }
    return new Response("?", { status: 404 });
  };
  return { handler, calls };
}

/** Installs the GitHub double for one call, restoring afterwards. */
async function withGithub<T>(
  gh: { handler: (url: string | URL) => Promise<Response> },
  run: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL) => gh.handler(url)) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

const ENV = { REGISTRY_SYNC_SECRET: "s" };

describe("the reconciler refuses to run without its dependencies", () => {
  test("no KV means no pass state, so no tick", async () => {
    const r = await runRegistryResyncLane(ENV, {
      kv: null,
      registrySyncApi: OK_API,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /kv/i);
  });

  test("no service binding means the write has nowhere to go", async () => {
    const r = await runRegistryResyncLane(ENV, {
      kv: kv(),
      registrySyncApi: null,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /registry-sync binding/i);
  });

  test("an unprovisioned secret is reported, not sent as undefined", async () => {
    const r = await runRegistryResyncLane(
      {},
      { kv: kv(), registrySyncApi: OK_API },
    );
    assert.equal(r.ok, false);
    assert.match(r.reason!, /secret/i);
  });
});

describe("a pass", () => {
  test("walks every registry file and reports counts", async () => {
    const gh = githubFetch({ subnets: ["a", "b"], providers: ["p"] });
    const store = kv();
    const r = await withGithub(gh, () =>
      runRegistryResyncLane(ENV, {
        kv: store,
        registrySyncApi: OK_API,
        now: () => 1000,
      }),
    );
    assert.equal(r.ok, true);
    assert.equal(r.total, 3, "two subnets and one provider");
    assert.equal(r.files, 3);
    assert.equal(r.complete, true, "3 files fit in one page");
    assert.equal(r.head, "aaa");
    // The completion timestamp is what gates the next pass.
    assert.equal(store.read("registry-resync:last-complete"), "1000");
  });

  test("a lane that has never completed a pass is due", async () => {
    // `Number(null)` is 0, so a naive interval check reads an absent
    // completion marker as "completed at the epoch" and, under any clock a
    // test controls, as NOT due. That is a first-tick-only bug in production.
    const gh = githubFetch({ subnets: ["a"], providers: [] });
    const r = await withGithub(gh, () =>
      runRegistryResyncLane(ENV, {
        kv: kv(),
        registrySyncApi: OK_API,
        now: () => 1000,
      }),
    );
    assert.equal(r.ok, true);
    assert.equal(r.reason, undefined, "no reason means it ran");
    assert.equal(r.complete, true);
  });

  test("a finished pass does not immediately restart", async () => {
    const gh = githubFetch();
    const store = kv({ "registry-resync:last-complete": "1000" });
    const r = await withGithub(gh, () =>
      runRegistryResyncLane(ENV, {
        kv: store,
        registrySyncApi: OK_API,
        now: () => 1000 + RESYNC_MIN_INTERVAL_MS - 1,
      }),
    );
    assert.equal(r.ok, true);
    assert.equal(r.reason, "not due");
    // Nothing was fetched -- the interval check comes before any GitHub call.
    assert.deepEqual(gh.calls, []);
  });

  test("starts again once the interval has elapsed", async () => {
    const gh = githubFetch();
    const store = kv({ "registry-resync:last-complete": "1000" });
    const r = await withGithub(gh, () =>
      runRegistryResyncLane(ENV, {
        kv: store,
        registrySyncApi: OK_API,
        now: () => 1000 + RESYNC_MIN_INTERVAL_MS,
      }),
    );
    assert.equal(r.ok, true);
    assert.equal(r.reason, undefined);
    assert.equal(r.complete, true);
  });

  test("spans ticks, and each tick continues where the last stopped", async () => {
    const many = Array.from(
      { length: RESYNC_PAGE_SIZE + 5 },
      (_, i) => `s${i}`,
    );
    const gh = githubFetch({ subnets: many, providers: [] });
    const store = kv();

    const first = await withGithub(gh, () =>
      runRegistryResyncLane(ENV, { kv: store, registrySyncApi: OK_API }),
    );
    assert.equal(first.ok, true);
    assert.equal(first.complete, undefined, "not finished after one page");
    assert.equal(first.offset, RESYNC_PAGE_SIZE);
    assert.equal(first.total, RESYNC_PAGE_SIZE + 5);

    const second = await withGithub(gh, () =>
      runRegistryResyncLane(ENV, { kv: store, registrySyncApi: OK_API }),
    );
    assert.equal(second.complete, true);
    assert.equal(second.offset, RESYNC_PAGE_SIZE + 5);
    assert.equal(
      second.files,
      5,
      "the second tick resolved only the remainder",
    );
  });

  // #11194: the pass state is PARSED, not cast. The four-clause guard this
  // replaced accepted anything that passed all four checks and nothing said
  // what the state WAS; the schema does both. Either way a state this lane
  // cannot read is discarded and the next tick starts a clean pass -- which is
  // the recovery, and the only behaviour a caller can observe.
  test("a stored state the schema rejects starts a clean pass", async () => {
    const store = kv({
      "registry-resync:state": JSON.stringify({
        head: "aaa",
        paths: ["registry/subnets/a.json"],
        offset: -1,
      }),
    });
    const result = await withGithub(
      githubFetch({ subnets: ["a", "b"], providers: [] }),
      () => runRegistryResyncLane(ENV, { kv: store, registrySyncApi: OK_API }),
    );
    assert.equal(result.ok, true);
    assert.equal(
      result.offset,
      2,
      "restarted from zero and walked the fresh listing, not the rejected state",
    );
  });

  test("stays pinned to the commit it started on", async () => {
    // A pass that re-resolved head each tick would mix files from two commits
    // and write them as though they were one.
    const many = Array.from(
      { length: RESYNC_PAGE_SIZE + 1 },
      (_, i) => `s${i}`,
    );
    const store = kv();
    await withGithub(
      githubFetch({ head: "aaa", subnets: many, providers: [] }),
      () => runRegistryResyncLane(ENV, { kv: store, registrySyncApi: OK_API }),
    );
    // main moves on between ticks.
    const moved = githubFetch({ head: "bbb", subnets: many, providers: [] });
    const second = await withGithub(moved, () =>
      runRegistryResyncLane(ENV, { kv: store, registrySyncApi: OK_API }),
    );
    assert.equal(
      second.head,
      "aaa",
      "the pass finishes on its original commit",
    );
    assert.ok(
      !moved.calls.some((c) => c.includes("/commits/main")),
      "a tick continuing a pass does not resolve head at all",
    );
  });

  test("a state left behind by a finished pass cannot restart it", async () => {
    const gh = githubFetch({ subnets: ["a"], providers: [] });
    const store = kv();
    await withGithub(gh, () =>
      runRegistryResyncLane(ENV, {
        kv: store,
        registrySyncApi: OK_API,
        now: () => 5000,
      }),
    );
    assert.equal(
      store.has("registry-resync:state") &&
        store.read("registry-resync:state") !== "",
      false,
      "the pass state is cleared on completion",
    );
  });
});

describe("failures do not advance the pass", () => {
  test("a rejected write leaves the offset where it was", async () => {
    const many = Array.from(
      { length: RESYNC_PAGE_SIZE + 5 },
      (_, i) => `s${i}`,
    );
    const gh = githubFetch({ subnets: many, providers: [] });
    const store = kv();
    const r = await withGithub(gh, () =>
      runRegistryResyncLane(ENV, { kv: store, registrySyncApi: REJECTING_API }),
    );
    assert.equal(r.ok, false);
    assert.match(r.reason!, /sync rejected/);
    assert.equal(r.offset, 0, "still at the page that failed");
    const state = JSON.parse(store.read("registry-resync:state")!) as {
      offset: number;
    };
    assert.equal(state.offset, 0);

    // The retry covers the same page, and can then proceed.
    const retry = await withGithub(gh, () =>
      runRegistryResyncLane(ENV, { kv: store, registrySyncApi: OK_API }),
    );
    assert.equal(retry.ok, true);
    assert.equal(retry.offset, RESYNC_PAGE_SIZE);
  });

  test("an unlistable directory fails the pass rather than reading as empty", async () => {
    // An empty listing and an unreachable one are the same shape, and treating
    // the second as the first would offer up a payload that deletes rows.
    const gh = githubFetch({ listingFails: true });
    const store = kv();
    const r = await withGithub(gh, () =>
      runRegistryResyncLane(ENV, { kv: store, registrySyncApi: OK_API }),
    );
    assert.equal(r.ok, false);
    assert.match(r.reason!, /could not list/i);
    assert.equal(store.read("registry-resync:last-complete"), null);
  });

  test("an empty registry is a failure, not a completed pass", async () => {
    const gh = githubFetch({ subnets: [], providers: [] });
    const r = await withGithub(gh, () =>
      runRegistryResyncLane(ENV, { kv: kv(), registrySyncApi: OK_API }),
    );
    assert.equal(r.ok, false);
    assert.match(r.reason!, /empty/i);
  });
});

describe("the verdict carries counts", () => {
  test("a providers-only page reports the providers it wrote", () => {
    // THE FIRST REAL PASS. Paths sort alphabetically, so page one is 100 of the
    // 136 registry/providers/* files. The verdict read
    //   ok :: 100/266 -- 100 file(s): 0 subnet(s), 0 surface(s), 0 deleted
    // while providers.updated_at moved from 160.7h stale to 3.5 minutes. The
    // lane had done its job and its own report said it had written nothing,
    // because the detail named three of RegistrySyncSummary's five fields.
    //
    // The earlier version of the test below could not catch that: it compared a
    // "wrote something" case against a "wrote nothing" case using the SAME
    // hand-picked field list the code used, so an omitted field was invisible
    // to both.
    const detail = resyncDetail({
      ok: true,
      files: 100,
      offset: 100,
      total: 266,
      written: {
        providers_written: 100,
        subnets_written: 0,
        surfaces_written: 0,
        surfaces_deleted: 0,
        subnets_deleted: 0,
      },
    });
    assert.match(detail, /providers_written=100/);
    assert.doesNotMatch(
      detail,
      /^(?!.*providers_written).*$/,
      "the count that moved must appear",
    );
  });

  test("every numeric count the route returns is reported", () => {
    // Enumerated from the RESPONSE, so a count added to the sync route shows up
    // without anyone remembering to add it here.
    const detail = resyncDetail({
      ok: true,
      files: 1,
      offset: 1,
      total: 1,
      written: { a_written: 1, b_written: 2, c_deleted: 3, note: "ignored" },
    });
    for (const key of ["a_written=1", "b_written=2", "c_deleted=3"]) {
      assert.match(detail, new RegExp(key));
    }
    assert.doesNotMatch(detail, /note/, "non-numeric fields are not counts");
  });

  test("a response with no counts says so rather than implying zero", () => {
    const detail = resyncDetail({
      ok: true,
      files: 40,
      offset: 40,
      total: 266,
      written: {},
    });
    assert.match(detail, /no counts returned/);
  });

  test("a pass that wrote nothing does not read like one that wrote everything", () => {
    const wrote = resyncDetail({
      ok: true,
      files: 100,
      offset: 100,
      total: 265,
      written: {
        subnets_written: 12,
        surfaces_written: 340,
        surfaces_deleted: 2,
      },
    });
    const nothing = resyncDetail({
      ok: true,
      files: 0,
      offset: 100,
      total: 265,
      written: { subnets_written: 0, surfaces_written: 0, surfaces_deleted: 0 },
    });
    assert.notEqual(wrote, nothing);
    assert.match(wrote, /100\/265/);
    assert.match(wrote, /surfaces_written=340/);
    assert.match(nothing, /0 file\(s\)/);
    assert.match(nothing, /surfaces_written=0/);
  });

  test("completion says so, and says where it finished", () => {
    const detail = resyncDetail({
      ok: true,
      complete: true,
      files: 65,
      offset: 265,
      total: 265,
      written: { subnets_written: 3 },
    });
    assert.match(detail, /pass complete at 265\/265/);
  });

  test("a failure names the reason and the status", () => {
    const detail = resyncDetail({
      ok: false,
      reason: "sync rejected",
      detail: "status 500",
    });
    assert.equal(detail, "sync rejected: status 500");
  });

  test("the lane name is stable", () => {
    assert.equal(REGISTRY_RESYNC_LANE, "registry-resync");
  });
});

describe("the lane is actually scheduled", () => {
  test("wrangler.jsonc declares the trigger", async () => {
    // Without this, the code merges, the dispatcher branch exists, every test
    // here passes -- and the lane never runs, which is precisely how the thing
    // it replaces went unnoticed for six days.
    const { REGISTRY_RESYNC_CRON } = await import("../workers/config.ts");
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );
    assert.ok(
      raw.includes(`"${REGISTRY_RESYNC_CRON}"`),
      `wrangler.jsonc has no trigger for ${REGISTRY_RESYNC_CRON}`,
    );
  });

  test("it does not share a minute with the incremental lane", async () => {
    // Both talk to the same GitHub rate-limit window and the same sync route.
    const { REGISTRY_RESYNC_CRON, REGISTRY_SYNC_CRON } =
      await import("../workers/config.ts");
    const minutes = (cron: string) => new Set(cron.split(" ")[0]!.split(","));
    const resync = minutes(REGISTRY_RESYNC_CRON);
    for (const m of minutes(REGISTRY_SYNC_CRON)) {
      assert.ok(!resync.has(m), `both lanes fire at minute ${m}`);
    }
  });
});
