// One subnet's 24h alpha volume, from the projection its chain-wide sibling already
// serves (#9371).
//
// Sixth instance of the shape #9367/#9369 fixed, and the one where the zeros were
// provably wrong from the sibling's OWN output. Measured live 2026-08-04,
// /api/v1/chain/alpha-volume carried subnet 64 in its per-subnet breakdown:
//
//   buy_volume_alpha 58,932.17   sell 66,733.61   total 125,665.78
//
// while /api/v1/subnets/64/volume reported 0 for every field — same fixed 24h window,
// same rows.
//
// The property this file exists for is the netuid filter. Both routes shape the SAME
// projection rows, so a per-subnet card that forgets to narrow them would report the
// whole network's volume as one subnet's: a confident, enormous, wrong number.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadSubnetAlphaVolumeFromArtifact } from "../src/subnet-alpha-volume-artifact.ts";

// The projection's own per-(netuid, event_kind) shape, with subnet 64's live figures.
const ROWS = [
  {
    netuid: 64,
    event_kind: "StakeAdded",
    alpha_volume: 58932.173512549,
    tao_volume: 5010.94930998,
    event_count: 19,
  },
  {
    netuid: 64,
    event_kind: "StakeRemoved",
    alpha_volume: 66733.611102935,
    tao_volume: 5670.1,
    event_count: 24,
  },
  {
    netuid: 7,
    event_kind: "StakeAdded",
    alpha_volume: 999999,
    tao_volume: 88888,
    event_count: 500,
  },
];

function bucket(body: unknown) {
  return {
    METAGRAPH_ARCHIVE: {
      get: async () => (body === undefined ? null : { json: async () => body }),
    },
  } as unknown as Env;
}

const ARTIFACT = {
  schema_version: 1,
  generated_at: "2026-08-04T10:15:00.000Z",
  windows: { "24h": { rows: ROWS, observed_at: "2026-08-04T10:15:00.000Z" } },
};

describe("loadSubnetAlphaVolumeFromArtifact", () => {
  test("shapes the requested subnet's rows, matching its chain-wide sibling", async () => {
    const got = await loadSubnetAlphaVolumeFromArtifact(bucket(ARTIFACT), 64);
    assert.equal(got?.data.buy_volume_alpha, 58932.173512549);
    assert.equal(got?.data.sell_volume_alpha, 66733.611102935);
    assert.equal(got?.data.total_volume_alpha, 125665.784615484);
  });

  test("does NOT leak another subnet's volume into this card", async () => {
    // Both routes read one shared row set. A missing narrow would report the network's
    // volume as one subnet's — vastly wrong, and confidently so.
    const got = await loadSubnetAlphaVolumeFromArtifact(bucket(ARTIFACT), 64);
    assert.ok(
      (got?.data.total_volume_alpha ?? 0) < 999999,
      "subnet 7's row bled into subnet 64's card",
    );
  });

  test("a subnet with no rows shapes to a real zero, not a decline", async () => {
    // This is the ONE case where zero is the right answer, and it must come through the
    // builder rather than through a guess.
    const got = await loadSubnetAlphaVolumeFromArtifact(bucket(ARTIFACT), 123);
    assert.equal(got?.data.total_volume_alpha, 0);
    assert.equal(got?.data.netuid, 123);
  });

  test("reports the lane's timestamp, so a stalled projection reads as stale", async () => {
    const got = await loadSubnetAlphaVolumeFromArtifact(bucket(ARTIFACT), 64);
    assert.equal(got?.generatedAt, "2026-08-04T10:15:00.000Z");
  });

  test("falls back to the envelope's generated_at when the window has none", async () => {
    const got = await loadSubnetAlphaVolumeFromArtifact(
      bucket({ ...ARTIFACT, windows: { "24h": { rows: ROWS } } }),
      64,
    );
    assert.equal(got?.generatedAt, "2026-08-04T10:15:00.000Z");
  });

  test("declines — never zeroes — when the store cannot answer faithfully", async () => {
    // Declining is what keeps "no trades" distinguishable from "could not read"; a zero
    // here would be the exact bug this closes.
    const cases: Array<[string, unknown]> = [
      ["no object", undefined],
      ["wrong schema_version", { schema_version: 2, windows: {} }],
      ["no windows", { schema_version: 1 }],
      [
        "missing 24h window",
        { schema_version: 1, windows: { "7d": { rows: [] } } },
      ],
      [
        "rows not an array",
        { schema_version: 1, windows: { "24h": { rows: "nope" } } },
      ],
    ];
    for (const [label, body] of cases) {
      assert.equal(
        await loadSubnetAlphaVolumeFromArtifact(bucket(body), 64),
        null,
        label,
      );
    }
  });

  test("an unbound archive declines rather than throwing", async () => {
    assert.equal(await loadSubnetAlphaVolumeFromArtifact({} as Env, 64), null);
    assert.equal(await loadSubnetAlphaVolumeFromArtifact(null, 64), null);
  });

  test("a malformed netuid declines without reading the artifact at all", async () => {
    let read = false;
    const env = {
      METAGRAPH_ARCHIVE: {
        get: async () => {
          read = true;
          return { json: async () => ARTIFACT };
        },
      },
    } as unknown as Env;
    assert.equal(
      await loadSubnetAlphaVolumeFromArtifact(env, Number.NaN),
      null,
    );
    assert.equal(await loadSubnetAlphaVolumeFromArtifact(env, -1), null);
    assert.equal(read, false, "fetched the projection for a malformed netuid");
  });

  test("netuid 0 is a real subnet, not a falsy skip", async () => {
    const body = {
      schema_version: 1,
      windows: {
        "24h": {
          rows: [
            {
              netuid: 0,
              event_kind: "StakeAdded",
              alpha_volume: 5,
              tao_volume: 1,
              event_count: 1,
            },
          ],
        },
      },
    };
    const got = await loadSubnetAlphaVolumeFromArtifact(bucket(body), 0);
    assert.equal(got?.data.netuid, 0);
    assert.equal(got?.data.buy_volume_alpha, 5);
  });

  test("a throwing store declines rather than propagating", async () => {
    const env = {
      METAGRAPH_ARCHIVE: {
        get: async () => {
          throw new Error("R2 down");
        },
      },
    } as unknown as Env;
    assert.equal(await loadSubnetAlphaVolumeFromArtifact(env, 64), null);
  });
});
