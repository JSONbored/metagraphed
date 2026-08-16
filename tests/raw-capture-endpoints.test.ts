// Which archive endpoints the raw-capture lane may read from.
//
// This selects hosts for the lane that carries the no-gap guarantee, so the
// dangerous direction is ACCEPTING a host that cannot serve historical state:
// capture reads `state_getStorage` up to a day back, and a pruned node answers
// `UnknownBlock: State already discarded` for every one of those heights. The
// other direction -- refusing a good host -- costs throughput and nothing else,
// because the configured default is always in the list.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  captureEndpointList,
  resolveCaptureEndpoints,
  RPC_POOLS_ARTIFACT_PATH,
} from "../src/raw-capture-endpoints.ts";
import { KV_HEALTH_RPC_POOL } from "../src/health-prober.ts";

const ARCHIVE = "https://archive.chain.opentensor.ai";
const ONFINALITY = "https://bittensor-finney.api.onfinality.io/public";

function endpoint(over: Record<string, unknown> = {}) {
  return {
    id: "opentensor-archive-rpc",
    url: ARCHIVE,
    kind: "subtensor-rpc",
    // The structural fields overlayRpcPoolEligibility RECOMPUTES eligibility
    // from. Omitting them makes the overlay refuse the row for a reason none of
    // these tests is about.
    auth_required: false,
    public_safe: true,
    pool_eligible: true,
    archive_support: true,
    status: "ok",
    ...over,
  };
}

function artifact(endpoints: Record<string, unknown>[], id = "finney-rpc") {
  return { ok: true, data: { pools: [{ id, endpoints }] } };
}

const deps = (
  result: unknown,
  live?: unknown,
): Parameters<typeof resolveCaptureEndpoints>[2] => ({
  readArtifact: async () => result as { ok?: boolean; data?: unknown },
  ...(live === undefined ? {} : { readHealthKv: async () => live }),
});

const ENV = { METAGRAPH_ARCHIVE: {} };

describe("resolveCaptureEndpoints", () => {
  test("returns the pool's archive-capable HTTP endpoints, in the pool's order", async () => {
    const got = await resolveCaptureEndpoints(
      ENV,
      "mainnet",
      deps(
        artifact([
          endpoint(),
          endpoint({ id: "onfinality-finney-rpc", url: ONFINALITY }),
        ]),
      ),
    );
    assert.deepEqual(got, [ARCHIVE, ONFINALITY]);
  });

  test("reads the pool artifact, by path", async () => {
    const asked: string[] = [];
    await resolveCaptureEndpoints(ENV, "mainnet", {
      readArtifact: async (_env, path) => {
        asked.push(path);
        return artifact([endpoint()]);
      },
    });
    assert.deepEqual(asked, [RPC_POOLS_ARTIFACT_PATH]);
  });

  test("REFUSES a pruned node, which is the dangerous direction", async () => {
    // `lite` and `entrypoint` answer chain_getHeader perfectly and cannot serve
    // one historical state read. Accepting one would stop the lane dead at its
    // first block, every tick, with a health check that says the host is fine.
    const got = await resolveCaptureEndpoints(
      ENV,
      "mainnet",
      deps(
        artifact([
          endpoint({ id: "lite", url: "https://lite", archive_support: false }),
          endpoint({ id: "unknown", url: "https://u", archive_support: null }),
        ]),
      ),
    );
    assert.deepEqual(got, []);
  });

  test("refuses an ineligible endpoint even when it is an archive", async () => {
    const got = await resolveCaptureEndpoints(
      ENV,
      "mainnet",
      deps(artifact([endpoint({ pool_eligible: false })])),
    );
    assert.deepEqual(got, []);
  });

  test("refuses wss, which this lane cannot POST to", async () => {
    // The `finney-archive` pool's four members are ALL wss -- perfectly healthy
    // archives this lane cannot call. That is why it reads the rpc pool.
    const got = await resolveCaptureEndpoints(
      ENV,
      "mainnet",
      deps(
        artifact([endpoint({ url: "wss://archive.chain.opentensor.ai:443" })]),
      ),
    );
    assert.deepEqual(got, []);
  });

  test("reads the network's OWN pool, never another's", async () => {
    const pools = {
      ok: true,
      data: {
        pools: [
          { id: "finney-rpc", endpoints: [endpoint()] },
          {
            id: "test-rpc",
            endpoints: [endpoint({ id: "t", url: "https://testnet" })],
          },
        ],
      },
    };
    assert.deepEqual(
      await resolveCaptureEndpoints(ENV, "testnet", deps(pools)),
      ["https://testnet"],
    );
    assert.deepEqual(
      await resolveCaptureEndpoints(ENV, "mainnet", deps(pools)),
      [ARCHIVE],
    );
  });

  test("the LIVE overlay decides, not the baked build", async () => {
    // The exact production bug this lane would otherwise inherit: /rpc/pools
    // served archive_support FALSE for two real archives on 2026-08-16 while
    // the live prober said true. Selecting on the baked value would find no
    // archive endpoints at all.
    const got = await resolveCaptureEndpoints(
      ENV,
      "mainnet",
      deps(artifact([endpoint({ archive_support: false })]), {
        endpoints: [
          { id: "opentensor-archive-rpc", status: "ok", archive_support: true },
        ],
      }),
    );
    assert.deepEqual(got, [ARCHIVE]);
  });

  test("asks the health KV for the pool snapshot by its own key", async () => {
    const asked: string[] = [];
    await resolveCaptureEndpoints(ENV, "mainnet", {
      readArtifact: async () => artifact([endpoint()]),
      readHealthKv: async (_env, key) => {
        asked.push(key);
        return null;
      },
    });
    assert.deepEqual(asked, [KV_HEALTH_RPC_POOL]);
  });

  test("a throwing overlay falls through to the baked pool, never to nothing", async () => {
    const got = await resolveCaptureEndpoints(ENV, "mainnet", {
      readArtifact: async () => artifact([endpoint()]),
      readHealthKv: async () => {
        throw new Error("kv down");
      },
    });
    assert.deepEqual(got, [ARCHIVE]);
  });

  test("every unreadable shape yields the empty list, never a throw", async () => {
    // The caller has a configured default for all of these; what it must never
    // get is an exception out of a cron's endpoint lookup.
    const shapes: unknown[] = [
      { ok: false, code: "artifact_not_found" },
      { ok: true, data: null },
      { ok: true, data: { pools: "not-an-array" } },
      { ok: true, data: { pools: [] } },
      { ok: true, data: { pools: [{ id: "finney-rpc" }] } },
    ];
    for (const shape of shapes) {
      assert.deepEqual(
        await resolveCaptureEndpoints(ENV, "mainnet", deps(shape)),
        [],
        `shape: ${JSON.stringify(shape)}`,
      );
    }
    assert.deepEqual(
      await resolveCaptureEndpoints(ENV, "mainnet", {
        readArtifact: async () => {
          throw new Error("r2 down");
        },
      }),
      [],
    );
    assert.deepEqual(
      await resolveCaptureEndpoints(
        null,
        "mainnet",
        deps(artifact([endpoint()])),
      ),
      [],
    );
  });
});

describe("captureEndpointList", () => {
  test("the configured default is always present, and always first", async () => {
    // It is the host whose behaviour under this exact call pattern was
    // measured, and the only one guaranteed to exist when the pool cannot be
    // read. A pool reordering must never demote it out of the rotation.
    assert.deepEqual(captureEndpointList(ARCHIVE, [ONFINALITY]), [
      ARCHIVE,
      ONFINALITY,
    ]);
    assert.deepEqual(captureEndpointList(ARCHIVE, []), [ARCHIVE]);
  });

  test("a pool that already names the default does not double its share", async () => {
    // Duplicates are not harmless here: the rotation would give that host two
    // slots in every cycle, i.e. twice the per-host rate the limit was measured
    // against.
    assert.deepEqual(
      captureEndpointList(ARCHIVE, [ARCHIVE, ONFINALITY, ARCHIVE]),
      [ARCHIVE, ONFINALITY],
    );
  });
});
