// #10932: the producer behind the cost-to-participate card.
//
// The assertions that matter here are about WHAT IS NOT WRITTEN. A lane that
// records a `found: false` for a file it could not open, or a reading with no
// citation, publishes a claim about a subnet nobody read -- which is the exact
// failure the card's four-valued GPU answer exists to prevent, arriving one
// layer earlier.
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import {
  COMPUTE_SPEC_MAX_BYTES,
  enqueueComputeDeclarations,
  handleComputeDeclarationBatch,
  minComputeSurfaces,
  parseComputeSpec,
  persistComputeDeclaration,
  rawGithubRef,
  readComputeDeclaration,
  resolveReadSha,
} from "../src/compute-declarations-lane.ts";
import worker, { handleScheduled } from "../workers/api.ts";
import { LANE_HEARTBEAT_CRON } from "../workers/config.ts";

type Row = Record<string, unknown>;

const RAW =
  "https://raw.githubusercontent.com/one-covenant/templar/main/min_compute.yml";
const SHA = "a".repeat(40);

/** Templar's real file, trimmed to the two stanzas this lane stores. */
const TEMPLAR_YML = `
version: '0.3.6'

compute_spec:

  miner:
    cpu:
      min_cores: 64           # Minimum number of CPU cores
    gpu:
      required: True
      min_vram: 192
      recommended_gpu: "NVIDIA B200"

  validator:
    cpu:
      min_cores: 64
`;

function fetchDouble(routes: Record<string, () => Response>) {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [prefix, make] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return make();
    }
    throw new Error(`unstubbed fetch: ${url}`);
  };
}

const COMMITS_API = "https://api.github.com/repos/one-covenant/templar/commits";

function okDeps(overrides: Record<string, () => Response> = {}) {
  return {
    fetchImpl: fetchDouble({
      [COMMITS_API]: () => Response.json([{ sha: SHA }]),
      [RAW]: () => new Response(TEMPLAR_YML),
      ...overrides,
    }) as unknown as typeof fetch,
    now: () => 1_760_000_000_000,
  };
}

describe("minComputeSurfaces", () => {
  const surfaces = [
    { netuid: 3, url: RAW, kind: "data-artifact", public_safe: true },
    // SN81 really does spell the file differently, which is why the match is
    // on the FILENAME and not on a surface id or title.
    {
      netuid: 81,
      url: "https://raw.githubusercontent.com/one-covenant/grail/main/compute.min.yaml",
      public_safe: true,
    },
    { netuid: 1, url: "https://example.com/README.md", public_safe: true },
    { netuid: 9, url: RAW, public_safe: false },
    { netuid: -1, url: RAW, public_safe: true },
    { url: RAW, public_safe: true },
  ];

  test("takes every public min_compute file, whatever it is called", () => {
    assert.deepEqual(minComputeSurfaces(surfaces), [
      { netuid: 3, source_url: RAW },
      {
        netuid: 81,
        source_url:
          "https://raw.githubusercontent.com/one-covenant/grail/main/compute.min.yaml",
      },
    ]);
  });

  test("skips a non-public surface, a bad netuid and a file it is not", () => {
    const urls = minComputeSurfaces(surfaces).map((m) => m.source_url);
    assert.equal(urls.includes("https://example.com/README.md"), false);
    assert.equal(
      minComputeSurfaces(surfaces).some((m) => m.netuid < 0),
      false,
    );
  });

  test("orders by netuid then url, so a partial send is a prefix", () => {
    // Two declarations for one subnet is a real shape -- a subnet can register
    // a miner repo and a validator repo -- and an unordered enqueue would make
    // which of them survives a partial send a lottery.
    //
    // `-` before `/` is CODE-UNIT order (0x2D < 0x2F). localeCompare puts them
    // the other way round, which is why it is not used: a machine ordering must
    // not be a function of the runtime's ICU data.
    const validator =
      "https://raw.githubusercontent.com/one-covenant/templar-validator/main/min_compute.yml";
    assert.deepEqual(
      minComputeSurfaces([
        { netuid: 3, url: validator, public_safe: true },
        { netuid: 3, url: RAW, public_safe: true },
        { netuid: 1, url: RAW, public_safe: true },
      ]).map((m) => `${m.netuid}:${m.source_url}`),
      [`1:${RAW}`, `3:${validator}`, `3:${RAW}`],
    );
    // Both arms of the tiebreak, and the equal case -- a duplicate URL for one
    // subnet is what the registry looks like mid-edit, and a comparator that
    // never returns 0 for it is one an engine may order either way.
    assert.deepEqual(
      minComputeSurfaces([
        { netuid: 3, url: RAW, public_safe: true },
        { netuid: 3, url: validator, public_safe: true },
        { netuid: 3, url: RAW, public_safe: true },
      ]).map((m) => m.source_url),
      [validator, RAW, RAW],
    );
  });

  test("tolerates nothing at all", () => {
    assert.deepEqual(minComputeSurfaces(null), []);
    assert.deepEqual(minComputeSurfaces(undefined), []);
    assert.deepEqual(minComputeSurfaces([]), []);
  });
});

describe("enqueueComputeDeclarations", () => {
  test("an empty set is not a success, and names its reason", async () => {
    // A producer reporting ok while enqueuing nothing is indistinguishable
    // from one that ran and found nothing to do -- how the revenue lane sat
    // dead for two months.
    assert.deepEqual(
      await enqueueComputeDeclarations({ sendBatch: async () => {} }, []),
      { ok: false, enqueued: 0, reason: "no_min_compute_surfaces" },
    );
  });

  test("a missing binding is a configuration error, not an empty set", async () => {
    const result = await enqueueComputeDeclarations(undefined, [
      { netuid: 3, source_url: RAW },
    ]);
    assert.equal(result.reason, "no_queue_binding");
  });
});

describe("rawGithubRef", () => {
  test("splits a raw URL into what the commits API needs", () => {
    assert.deepEqual(rawGithubRef(RAW), {
      owner: "one-covenant",
      repo: "templar",
      ref: "main",
      path: "min_compute.yml",
    });
    assert.deepEqual(
      rawGithubRef(
        "https://raw.githubusercontent.com/o/r/main/deep/dir/min_compute.yml",
      )?.path,
      "deep/dir/min_compute.yml",
    );
  });

  test("answers null for anything it cannot cite", () => {
    // A non-GitHub host is skipped rather than read without a citation, which
    // is the one thing a reading may not be.
    assert.equal(rawGithubRef("https://example.com/min_compute.yml"), null);
    assert.equal(rawGithubRef("not a url"), null);
    assert.equal(rawGithubRef("https://raw.githubusercontent.com/o/r"), null);
    assert.equal(
      rawGithubRef("https://raw.githubusercontent.com/o/r/main"),
      null,
    );
  });
});

describe("resolveReadSha", () => {
  const ref = {
    owner: "one-covenant",
    repo: "templar",
    ref: "main",
    path: "min_compute.yml",
  };

  test("asks for the commit that last touched THIS PATH", async () => {
    let asked = "";
    const sha = await resolveReadSha(ref, {
      fetchImpl: (async (input: RequestInfo | URL) => {
        asked = String(input);
        return Response.json([{ sha: SHA }]);
      }) as unknown as typeof fetch,
    });
    assert.equal(sha, SHA);
    // Not the branch head: a head advances on commits that never went near
    // this file, so read_at_sha would change hourly and a re-read diff would
    // report a declaration that moved when nothing did.
    assert.match(asked, /\/commits\?path=min_compute\.yml&sha=main&per_page=1/);
  });

  test("a ref that is already a commit costs no request", async () => {
    const sha = await resolveReadSha(
      { ...ref, ref: SHA },
      {
        fetchImpl: (() => {
          throw new Error("must not fetch");
        }) as unknown as typeof fetch,
      },
    );
    assert.equal(sha, SHA);
  });

  test("sends the token when there is one, and works without", async () => {
    const seen: Array<string | undefined> = [];
    const fetchImpl = (async (_i: unknown, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>)?.authorization);
      return Response.json([{ sha: SHA }]);
    }) as unknown as typeof fetch;
    await resolveReadSha(ref, { fetchImpl, githubAuth: "Bearer t" });
    await resolveReadSha(ref, { fetchImpl, githubAuth: null });
    assert.deepEqual(seen, ["Bearer t", undefined]);
  });

  test("an unusable answer is null, never a made-up sha", async () => {
    const cases: Array<() => Response> = [
      () => new Response("nope", { status: 404 }),
      () => Response.json([]),
      () => Response.json([{ sha: 12 }]),
      () => Response.json({ sha: SHA }),
      () => Response.json([{ sha: "abc" }]),
    ];
    for (const make of cases) {
      assert.equal(
        await resolveReadSha(ref, {
          fetchImpl: (async () => make()) as unknown as typeof fetch,
        }),
        null,
      );
    }
  });
});

describe("parseComputeSpec", () => {
  test("takes the two stanzas raw, and the file's own version", () => {
    const parsed = parseComputeSpec(TEMPLAR_YML);
    assert.equal(parsed?.spec_version, "0.3.6");
    // RAW. `required: True` is still a boolean here and `min_vram` still 192 --
    // the tri-state rule and every unit run at SERVING time, so improving the
    // interpretation never means re-fetching seventeen files.
    assert.deepEqual((parsed?.miner as Row).gpu, {
      required: true,
      min_vram: 192,
      recommended_gpu: "NVIDIA B200",
    });
    assert.deepEqual((parsed?.validator as Row).cpu, { min_cores: 64 });
  });

  test("an unquoted numeric version survives as text", () => {
    // `version: 0.3` is a NUMBER in YAML and the column is TEXT. Both are the
    // file's own answer.
    assert.equal(
      parseComputeSpec("version: 3\ncompute_spec:\n  miner:\n    cpu: {}\n")
        ?.spec_version,
      "3",
    );
  });

  test("a compute_spec declaring neither role is still a document", () => {
    const parsed = parseComputeSpec("compute_spec:\n  notes: hello\n");
    assert.ok(parsed);
    assert.equal(parsed.miner, null);
    assert.equal(parsed.validator, null);
    assert.equal(parsed.spec_version, null);
  });

  test("null when there is no compute_spec to read", () => {
    // Each of these is a document we fetched and could not read a spec out of,
    // which the caller records as `found: false` -- a measurement. It is NOT
    // the same as a file nobody could open, which writes nothing at all.
    assert.equal(parseComputeSpec(""), null);
    assert.equal(parseComputeSpec("- a\n- b\n"), null);
    assert.equal(parseComputeSpec("<html>404</html>"), null);
    assert.equal(parseComputeSpec("version: 1\n"), null);
    assert.equal(parseComputeSpec("compute_spec: not-a-mapping\n"), null);
    assert.equal(parseComputeSpec("compute_spec:\n  - miner\n"), null);
    // Unparseable YAML is caught, not thrown: one bad file must not take out
    // the batch delivered beside it.
    assert.equal(parseComputeSpec("a:\n  - b\n c: {{{"), null);
  });
});

describe("readComputeDeclaration", () => {
  const message = { netuid: 3, source_url: RAW };

  test("records what it read, when, and at which commit", async () => {
    const record = await readComputeDeclaration(message, okDeps());
    assert.equal(record?.netuid, 3);
    assert.equal(record?.read_at_sha, SHA);
    assert.equal(record?.observed_at, 1_760_000_000_000);
    assert.equal(record?.found, true);
    assert.equal(record?.spec_version, "0.3.6");
    assert.ok(record?.miner);
  });

  test("A FILE NOBODY COULD OPEN WRITES NOTHING", async () => {
    // Djinn's surface 404s today. `found: false` would say "we read it at a
    // commit and it declared nothing", which is a measurement we did not take
    // -- and the health prober already reports that surface as dead.
    for (const status of [404, 410, 500, 503]) {
      const record = await readComputeDeclaration(
        message,
        okDeps({ [RAW]: () => new Response("", { status }) }),
      );
      assert.equal(record, null, `HTTP ${status} must write nothing`);
    }
  });

  test("a reading with no citation is not a reading", async () => {
    const record = await readComputeDeclaration(
      message,
      okDeps({ [COMMITS_API]: () => new Response("", { status: 403 }) }),
    );
    assert.equal(record, null);
  });

  test("a surface it cannot cite at all is skipped", async () => {
    assert.equal(
      await readComputeDeclaration(
        { netuid: 3, source_url: "https://example.com/min_compute.yml" },
        okDeps(),
      ),
      null,
    );
  });

  test("an oversized response is not a compute spec", async () => {
    const record = await readComputeDeclaration(
      message,
      okDeps({
        [RAW]: () => new Response("x".repeat(COMPUTE_SPEC_MAX_BYTES + 1)),
      }),
    );
    assert.equal(record, null);
  });

  test("a document with no spec is found:false, WITH its citation", async () => {
    // The real middle state: fetched at a commit, carried no compute_spec.
    const record = await readComputeDeclaration(
      message,
      okDeps({ [RAW]: () => new Response("version: 1\n") }),
    );
    assert.equal(record?.found, false);
    assert.equal(record?.miner, null);
    assert.equal(record?.read_at_sha, SHA);
  });
});

describe("persistComputeDeclaration", () => {
  function db() {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    return {
      calls,
      run: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
      },
    };
  }

  test("upserts, and preserves first_seen across a re-read", async () => {
    const store = db();
    const record = await readComputeDeclaration(
      { netuid: 3, source_url: RAW },
      okDeps(),
    );
    assert.ok(record);
    assert.deepEqual(await persistComputeDeclaration(store, record), {
      ok: true,
    });
    const [call] = store.calls;
    assert.match(call.sql, /ON CONFLICT \(netuid, source_url\) DO UPDATE/);
    assert.equal(
      /first_seen/.test(call.sql.split("DO UPDATE")[1]!),
      false,
      "first_seen must not be overwritten -- 'watching since' has to survive a file that moves weekly",
    );
    // The stanzas go in as JSON text; the column is JSONB.
    assert.equal(typeof call.params[7], "string");
  });

  test("a found:false row carries no stanza, whatever it was handed", async () => {
    // The CHECK constraint refuses this at the database. Making it true at the
    // source means the write never has to bounce to be correct.
    const store = db();
    await persistComputeDeclaration(store, {
      netuid: 3,
      source_url: RAW,
      read_at_sha: SHA,
      observed_at: 1,
      found: false,
      spec_version: null,
      miner: { cpu: {} },
      validator: { cpu: {} },
    });
    assert.equal(store.calls[0].params[7], null);
    assert.equal(store.calls[0].params[8], null);
  });

  test("no store is a failure, so the message retries", async () => {
    assert.deepEqual(
      await persistComputeDeclaration(null, {
        netuid: 3,
        source_url: RAW,
        read_at_sha: SHA,
        observed_at: 1,
        found: true,
        spec_version: null,
        miner: {},
        validator: null,
      }),
      // NAMED, not a bare false. The reason rides out to the retry report, so
      // "this lane is retrying" and "this lane has no store bound" stop
      // looking the same in error tracking.
      { ok: false, reason: "no_store_binding" },
    );
  });
});

describe("handleComputeDeclarationBatch", () => {
  function message(body: unknown) {
    const state = { acked: 0, retried: 0 };
    return {
      state,
      message: {
        body,
        ack: () => {
          state.acked += 1;
        },
        retry: () => {
          state.retried += 1;
        },
      },
    };
  }

  test("writes a reading and acks", async () => {
    const written: unknown[] = [];
    const m = message({ netuid: 3, source_url: RAW });
    const result = await handleComputeDeclarationBatch(
      [m.message],
      { run: async (_sql, params) => void written.push(params) },
      okDeps(),
    );
    assert.equal(result.done, 1);
    assert.equal(m.state.acked, 1);
    assert.equal(written.length, 1);
  });

  test("A SURFACE THAT WRITES NOTHING IS ACKED, NOT RETRIED", async () => {
    // None of the three reasons changes on redelivery, so retrying a 404
    // spends the whole budget to reach the dead letter with a message nobody
    // can act on.
    const m = message({ netuid: 3, source_url: RAW });
    const result = await handleComputeDeclarationBatch(
      [m.message],
      { run: async () => {} },
      okDeps({ [RAW]: () => new Response("", { status: 404 }) }),
    );
    assert.equal(m.state.acked, 1);
    assert.equal(m.state.retried, 0);
    assert.equal(result.done, 1);
  });

  test("a failed write retries, because an unwritten result is unread", async () => {
    const m = message({ netuid: 3, source_url: RAW });
    await handleComputeDeclarationBatch([m.message], null, okDeps());
    assert.equal(m.state.retried, 1);
    assert.equal(m.state.acked, 0);
  });

  test("an unusable body is dropped rather than looped to the dead letter", async () => {
    const bad = [
      message(null),
      message({ netuid: "x", source_url: RAW }),
      message({ netuid: 3 }),
    ];
    const result = await handleComputeDeclarationBatch(
      bad.map((b) => b.message),
      { run: async () => {} },
      okDeps(),
    );
    assert.equal(result.dropped, 3);
    for (const b of bad) assert.equal(b.state.acked, 1);
  });

  test("one bad message costs one subject, not the batch", async () => {
    const good = message({ netuid: 3, source_url: RAW });
    const bad = message({ netuid: 4, source_url: RAW });
    let first = true;
    const result = await handleComputeDeclarationBatch(
      [bad.message, good.message],
      {
        run: async () => {
          if (first) {
            first = false;
            throw new Error("write exploded");
          }
        },
      },
      okDeps(),
    );
    assert.equal(bad.state.retried, 1);
    assert.equal(good.state.acked, 1);
    assert.equal(result.done, 1);
  });
});

describe("the injected seams fall back to the runtime's own", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("no fetch and no clock still reads, cites and stamps", async () => {
    // The `?? fetch` / `?? Date.now` arms are what runs in production -- the
    // Worker passes neither -- so leaving them unexercised would test only the
    // shape the tests themselves construct.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith(COMMITS_API)
          ? Response.json([{ sha: SHA }])
          : new Response(TEMPLAR_YML),
      ),
    );
    const before = Date.now();
    const record = await readComputeDeclaration({ netuid: 3, source_url: RAW });
    assert.equal(record?.read_at_sha, SHA);
    assert.ok(
      (record?.observed_at ?? 0) >= before,
      "observed_at must be the real clock, not zero",
    );
  });
});

// --- through the Worker's own handlers ---------------------------------------
//
// The unit tests above prove the lane's decisions; these prove it is WIRED.
// A producer nobody enqueues and a consumer branch nobody routes to are both
// perfectly correct code that never runs -- and the failure looks exactly like
// a table nobody writes, which is the state this whole lane exists to end.
describe("the compute-declarations lane, end to end", () => {
  const registry = {
    surfaces: [
      {
        id: "sn-3-templar-min-compute",
        netuid: 3,
        url: RAW,
        public_safe: true,
      },
      {
        id: "sn-1-readme",
        netuid: 1,
        url: "https://x.example/README.md",
        public_safe: true,
      },
    ],
  };

  function env(payload: unknown, extra: Record<string, unknown> = {}) {
    const hit = (p: string) =>
      p === "/metagraph/surfaces.json" && payload != null;
    return {
      ASSETS: {
        async fetch(request: Request) {
          const { pathname } = new URL(request.url);
          return hit(pathname)
            ? Response.json(payload as never)
            : new Response("{}", { status: 404 });
        },
      },
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          const p = `/metagraph/${String(key).replace(/^latest\//, "")}`;
          return hit(p)
            ? {
                async json() {
                  return payload;
                },
              }
            : null;
        },
      },
      ...extra,
    };
  }

  test("the heartbeat enqueues every registered declaration, and only those", async () => {
    const sent: unknown[] = [];
    const result = await handleScheduled(
      { cron: LANE_HEARTBEAT_CRON } as unknown as ScheduledController,
      env(registry, {
        PROBE_JOBS: {
          async sendBatch(messages: Array<{ body: unknown }>) {
            for (const m of messages) sent.push(m.body);
          },
        },
      }) as never,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
    const lanes = (result as { lanes?: Array<Record<string, unknown>> }).lanes;
    const lane = (lanes ?? []).find((l) => l.lane === "compute-declarations");
    assert.ok(lane, "compute-declarations must be in LANE_PRODUCERS");
    assert.equal(lane.ok, true, JSON.stringify(lane));
    assert.equal(lane.enqueued, 1);
    // FILTERED BY `job_type`, because the heartbeat runs every probe producer
    // and they all write to ONE queue now (#10894). This capture therefore sees
    // origin-reachability's messages beside this lane's, which is the
    // discriminator earning its keep rather than a leak: a consumer partitions
    // on exactly this field.
    const mine = sent.filter(
      (body) =>
        (body as { job_type?: string }).job_type === "compute-declaration",
    );
    // The README surface is not a declaration and must not be enqueued.
    assert.deepEqual(mine, [
      { job_type: "compute-declaration", netuid: 3, source_url: RAW },
    ]);
  });

  test("a declaration batch routes to THIS consumer, not the webhook path", async () => {
    // Stubbed rather than left live: tests/setup/no-outbound-fetch.ts throws on
    // any real host, consumeBatch catches it, and the message would retry --
    // so an unstubbed version of this test passes while asserting nothing.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith(COMMITS_API)
          ? Response.json([{ sha: SHA }])
          : new Response(TEMPLAR_YML),
      ),
    );
    let acked = 0;
    let retried = 0;
    const batch = {
      queue: "probe-jobs",
      messages: [
        {
          body: { job_type: "compute-declaration", netuid: 3, source_url: RAW },
          ack: () => {
            acked += 1;
          },
          retry: () => {
            retried += 1;
          },
        },
      ],
    };
    await worker.queue!(
      batch as never,
      env(registry) as never,
      { waitUntil: () => {} } as never,
    );
    // THE FETCH IS THE ASSERTION. Only this consumer reads a declaration, so a
    // request for that URL proves the batch reached it -- the webhook path
    // would have POSTed the body at a subscriber and the origin path would
    // have looked for an `origin` field it does not have.
    const fetched = (
      globalThis.fetch as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.map((c) => String(c[0]));
    assert.ok(
      fetched.some((u) => u === RAW),
      `the consumer never read the declaration: ${JSON.stringify(fetched)}`,
    );
    // ...and it RETRIES, because this harness binds no store. An unwritten
    // result is one nothing can read, so the work did not happen as far as any
    // reader is concerned -- acking here would lose the reading silently.
    assert.equal(acked, 0);
    assert.equal(retried, 1);
    vi.unstubAllGlobals();
  });
});
