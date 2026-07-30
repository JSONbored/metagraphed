// Tests for src/subnet-news.ts (#8704).
//
// FIXTURE PROVENANCE — captured 2026-07-30 from the live production API, not
// typed from a schema:
//
//   HYPERPARAM_SNAPSHOTS
//     GET https://api.metagraph.sh/api/v1/subnets/64/hyperparameters/history?limit=2
//   OWNERSHIP_ROW
//     GET https://api.metagraph.sh/api/v1/chain-events?pallet=SubtensorModule
//         &method=SubnetOwnerChanged&limit=3
//     (one row exists chain-wide; this is it, verbatim)
//
// The capture caught three things a hand-typed fixture would have missed, and
// each is asserted below:
//   * hyperparameter history stores SNAPSHOTS, not diffs
//   * SubnetOwnerChanged carries `netuid` as a positional ARRAY ([18])
//   * it has extrinsic_index: null / phase "Initialization" — nothing to link
//
// SubnetLeaseCreated/Terminated have ZERO occurrences chain-wide, so there is
// no row to capture. Those tests exercise the shared envelope using the real
// ownership row's structure with the method swapped, and assert only what the
// envelope supports — never decoded lease terms.

import { describe, expect, it } from "vitest";
import {
  blockUrl,
  diffHyperparamSnapshots,
  extrinsicUrl,
  hyperparamChangeItems,
  leaseEventItems,
  NEWS_CAPS,
  newsItem,
  ownershipChangeItems,
  subnetNewsItems,
  unwrapArg,
} from "../src/subnet-news.ts";

// Real snapshot, trimmed to the fields the differ reads plus enough noise
// fields to prove the allowlist works. Values verbatim from SN64.
const BASE_HYPERPARAMS = {
  kappa_ratio: 0.49999237,
  immunity_period: 5000,
  min_allowed_weights: 1,
  max_weight_limit_ratio: 1,
  tempo: 360,
  weights_version: 0,
  weights_rate_limit: 100,
  activity_cutoff: 5000,
  activity_cutoff_factor: 13889,
  registration_allowed: true,
  target_regs_per_interval: 1,
  min_burn_tao: 0.0005,
  max_burn_tao: 100,
  burn_half_life: 360,
  burn_increase_mult: 1.26,
  bonds_moving_avg_raw: 900000,
  max_regs_per_block: 1,
  serving_rate_limit: 50,
  max_validators: 64,
  commit_reveal_period: 1,
  commit_reveal_enabled: false,
  alpha_high_ratio: 0.90000763,
  alpha_low_ratio: 0.70000763,
  liquid_alpha_enabled: false,
  alpha_sigmoid_steepness: 1000,
  yuma_version: 2,
  subnet_is_active: true,
  transfers_enabled: true,
};

const HYPERPARAM_SNAPSHOTS = [
  {
    block_number: 8611693,
    observed_at: "2026-07-13T09:48:49.763Z",
    hyperparameters: { ...BASE_HYPERPARAMS },
  },
  {
    block_number: 8700000,
    observed_at: "2026-07-25T10:00:00.000Z",
    hyperparameters: {
      ...BASE_HYPERPARAMS,
      tempo: 720,
      registration_allowed: false,
      // Float noise on a NON-newsworthy field: must produce no item.
      kappa_ratio: 0.49999238,
    },
  },
];

// Verbatim capture. Note netuid: [18] and extrinsic_index: null.
const OWNERSHIP_ROW = {
  block_number: 8724813,
  event_index: 137,
  pallet: "SubtensorModule",
  method: "SubnetOwnerChanged",
  args: {
    netuid: [18],
    new_coldkey: "5GgvCi6h7dNsC489T8UnUMv912SoEXpEUDVt71VJU1Td7WKh",
    old_coldkey: "5DHwWLjtpwnZQUQKKXE2N5Gdy2N8PpqhgjLUuzgSB7yuGZkF",
  },
  phase: "Initialization",
  extrinsic_index: null,
  observed_at: 1785294096000,
  summary: null,
};

describe("unwrapArg", () => {
  it("reads a positional array arg and a scalar alike", () => {
    // SubnetOwnerChanged emits netuid: [18]; other events emit a number.
    expect(unwrapArg([18])).toBe(18);
    expect(unwrapArg(18)).toBe(18);
    expect(unwrapArg(undefined)).toBeUndefined();
    expect(unwrapArg([])).toBeUndefined();
  });
});

describe("newsItem — no citation, no item", () => {
  const valid = {
    id: "x",
    url: "https://metagraph.sh/blocks/1",
    title: "t",
    summary: "s",
    timestamp: "2026-07-30T00:00:00.000Z",
    tags: ["chain"],
  };

  it("builds an item when it can cite a source", () => {
    expect(newsItem(valid)).toEqual(valid);
  });

  it("refuses to build without a url", () => {
    // The invariant that keeps "aggregated" from becoming "made up".
    expect(newsItem({ ...valid, url: "" })).toBeNull();
    expect(newsItem({ ...valid, url: "   " })).toBeNull();
    expect(newsItem({ ...valid, url: undefined as never })).toBeNull();
  });

  it("refuses to build without a timestamp, id, or title", () => {
    expect(newsItem({ ...valid, timestamp: null })).toBeNull();
    expect(newsItem({ ...valid, id: "" })).toBeNull();
    expect(newsItem({ ...valid, title: "" })).toBeNull();
  });
});

describe("diffHyperparamSnapshots", () => {
  it("computes changes by diffing snapshots, because there is no change table", () => {
    const changes = diffHyperparamSnapshots(HYPERPARAM_SNAPSHOTS);
    const byParam = Object.fromEntries(changes.map((c) => [c.param, c]));
    expect(Object.keys(byParam).sort()).toEqual([
      "registration_allowed",
      "tempo",
    ]);
    expect(byParam.tempo.before).toBe(360);
    expect(byParam.tempo.after).toBe(720);
    expect(byParam.tempo.block_number).toBe(8700000);
  });

  it("ignores float noise on non-newsworthy fields", () => {
    // kappa_ratio moved 0.49999237 -> 0.49999238 in the fixture. Governance
    // set 0.5; the reading is noisy. An item per tick of that would bury the
    // changes an operator needs.
    const changes = diffHyperparamSnapshots(HYPERPARAM_SNAPSHOTS);
    expect(changes.some((c) => c.param === "kappa_ratio")).toBe(false);
  });

  it("emits nothing for a single snapshot", () => {
    // The first row has no earlier state; reporting it as a change would be an
    // item about our retention window, not about the subnet.
    expect(diffHyperparamSnapshots([HYPERPARAM_SNAPSHOTS[0]])).toEqual([]);
    expect(diffHyperparamSnapshots([])).toEqual([]);
    expect(diffHyperparamSnapshots(null)).toEqual([]);
  });

  it("does not report a param that is missing from either snapshot", () => {
    // An absent field is a schema change on our side, not governance on theirs.
    const changes = diffHyperparamSnapshots([
      {
        block_number: 1,
        observed_at: "2026-07-01T00:00:00.000Z",
        hyperparameters: { tempo: 360 },
      },
      {
        block_number: 2,
        observed_at: "2026-07-02T00:00:00.000Z",
        hyperparameters: { max_validators: 64 },
      },
    ]);
    expect(changes).toEqual([]);
  });

  it("skips rows it cannot date or number", () => {
    expect(
      diffHyperparamSnapshots([
        HYPERPARAM_SNAPSHOTS[0],
        { ...HYPERPARAM_SNAPSHOTS[1], observed_at: "" },
      ]),
    ).toEqual([]);
  });
});

describe("hyperparamChangeItems", () => {
  it("renders a readable before → after with a block citation", () => {
    const items = hyperparamChangeItems(64, HYPERPARAM_SNAPSHOTS);
    const tempo = items.find((i) => i.id.endsWith(":tempo"));
    expect(tempo?.title).toBe("Subnet 64: Tempo 360 → 720");
    expect(tempo?.url).toBe(blockUrl(8700000));
    expect(tempo?.tags).toEqual(["chain", "hyperparam", "sn64"]);
  });

  it("renders booleans as words, not true/false", () => {
    const items = hyperparamChangeItems(64, HYPERPARAM_SNAPSHOTS);
    const reg = items.find((i) => i.id.endsWith(":registration_allowed"));
    expect(reg?.title).toBe("Subnet 64: Registration enabled → disabled");
  });

  it("is byte-stable across repeated builds", () => {
    expect(hyperparamChangeItems(64, HYPERPARAM_SNAPSHOTS)).toEqual(
      hyperparamChangeItems(64, HYPERPARAM_SNAPSHOTS),
    );
  });

  it("caps a flood and keeps the newest", () => {
    // Build a run of snapshots that moves tempo every block. Without the cap
    // this floods the whole 50-item feed with one subnet's parameter churn.
    const flood = [
      {
        block_number: 1000,
        observed_at: "2026-07-01T00:00:00.000Z",
        hyperparameters: { ...BASE_HYPERPARAMS },
      },
    ];
    for (let i = 1; i <= 40; i += 1) {
      flood.push({
        block_number: 1000 + i,
        observed_at: new Date(Date.UTC(2026, 6, 1, i)).toISOString(),
        hyperparameters: { ...BASE_HYPERPARAMS, tempo: 360 + i },
      });
    }
    const items = hyperparamChangeItems(64, flood);
    expect(items).toHaveLength(NEWS_CAPS["hyperparam-change"]);
    // Newest kept, not whichever was scanned last.
    expect(items[0].id).toContain(":1040:");
  });

  it("respects an explicit cap override", () => {
    expect(
      hyperparamChangeItems(64, HYPERPARAM_SNAPSHOTS, { cap: 1 }),
    ).toHaveLength(1);
    expect(hyperparamChangeItems(64, HYPERPARAM_SNAPSHOTS, { cap: 0 })).toEqual(
      [],
    );
  });
});

describe("ownershipChangeItems", () => {
  it("reads the real captured row, positional netuid and all", () => {
    const items = ownershipChangeItems(18, [OWNERSHIP_ROW]);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Subnet 18 ownership transferred");
    // netuid: [18] must match subnet 18 — a scalar-only read would drop this.
    expect(items[0].id).toBe("chain:sn18:owner:8724813:137");
  });

  it("cites the block when there is no extrinsic to cite", () => {
    // The captured row is phase "Initialization" with extrinsic_index: null —
    // emitted by runtime logic, not a signed call.
    expect(ownershipChangeItems(18, [OWNERSHIP_ROW])[0].url).toBe(
      blockUrl(8724813),
    );
  });

  it("prefers the extrinsic when one is present", () => {
    const items = ownershipChangeItems(18, [
      { ...OWNERSHIP_ROW, extrinsic_index: 44 },
    ]);
    expect(items[0].url).toBe(extrinsicUrl(8724813, 44));
  });

  it("converts the epoch-ms observed_at the tier actually returns", () => {
    expect(ownershipChangeItems(18, [OWNERSHIP_ROW])[0].timestamp).toBe(
      new Date(1785294096000).toISOString(),
    );
  });

  it("abbreviates addresses rather than pasting 48 chars into a title", () => {
    const summary = ownershipChangeItems(18, [OWNERSHIP_ROW])[0].summary;
    expect(summary).toContain("5DHwWL…GZkF");
    expect(summary).toContain("5GgvCi…7WKh");
  });

  it("drops a row belonging to a different subnet", () => {
    expect(ownershipChangeItems(64, [OWNERSHIP_ROW])).toEqual([]);
  });

  it("caps and is total over degenerate input", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...OWNERSHIP_ROW,
      block_number: 8724813 + i,
      event_index: i,
    }));
    expect(ownershipChangeItems(18, many)).toHaveLength(
      NEWS_CAPS["ownership-change"],
    );
    expect(ownershipChangeItems(18, null)).toEqual([]);
    expect(ownershipChangeItems(18, [{ block_number: NaN }])).toEqual([]);
  });
});

describe("leaseEventItems", () => {
  // No lease event has fired chain-wide in our indexed window, so these use
  // the real ownership row's ENVELOPE with the method swapped, and assert only
  // envelope-supported facts — never decoded lease terms.
  const leaseRow = {
    ...OWNERSHIP_ROW,
    method: "SubnetLeaseCreated",
    event_index: 12,
    args: { netuid: [18] },
  };

  it("reports the event and cites its block", () => {
    const items = leaseEventItems(18, [leaseRow]);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Subnet 18 leased");
    expect(items[0].url).toBe(blockUrl(8724813));
    expect(items[0].tags).toContain("lease");
  });

  it("claims nothing about lease terms", () => {
    // The payload has never been observed; the item must not imply otherwise.
    const summary = leaseEventItems(18, [leaseRow])[0].summary;
    for (const banned of ["duration", "beneficiary", "until", "expires"]) {
      expect(summary.toLowerCase()).not.toContain(banned);
    }
  });

  it("handles termination", () => {
    expect(
      leaseEventItems(18, [{ ...leaseRow, method: "SubnetLeaseTerminated" }])[0]
        .title,
    ).toBe("Subnet 18 lease terminated");
  });

  it("ignores unrelated methods", () => {
    expect(leaseEventItems(18, [OWNERSHIP_ROW])).toEqual([]);
    expect(leaseEventItems(18, [{ ...leaseRow, method: "" }])).toEqual([]);
  });

  it("caps and is total over degenerate input", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...leaseRow,
      event_index: i,
    }));
    expect(leaseEventItems(18, many)).toHaveLength(NEWS_CAPS["lease-event"]);
    expect(leaseEventItems(18, null)).toEqual([]);
  });
});

describe("subnetNewsItems", () => {
  it("merges every lane, newest first", () => {
    const items = subnetNewsItems({
      netuid: 18,
      hyperparamSnapshots: HYPERPARAM_SNAPSHOTS.map((s) => ({ ...s })),
      ownershipRows: [OWNERSHIP_ROW],
      leaseRows: [],
    });
    expect(items.length).toBeGreaterThan(0);
    for (let i = 1; i < items.length; i += 1) {
      expect(items[i - 1].timestamp >= items[i].timestamp).toBe(true);
    }
  });

  it("every item carries a resolvable absolute URL", () => {
    // The module's central promise, asserted over the merged output.
    const items = subnetNewsItems({
      netuid: 18,
      hyperparamSnapshots: HYPERPARAM_SNAPSHOTS.map((s) => ({ ...s })),
      ownershipRows: [OWNERSHIP_ROW],
    });
    for (const item of items) {
      expect(() => new URL(item.url)).not.toThrow();
      expect(item.tags).toContain("chain");
    }
  });

  it("one lane flooding cannot starve another", () => {
    const flood = [
      {
        block_number: 1000,
        observed_at: "2026-07-01T00:00:00.000Z",
        hyperparameters: { ...BASE_HYPERPARAMS },
      },
    ];
    for (let i = 1; i <= 60; i += 1) {
      flood.push({
        block_number: 1000 + i,
        observed_at: new Date(Date.UTC(2026, 6, 1, i % 24, i)).toISOString(),
        hyperparameters: { ...BASE_HYPERPARAMS, tempo: 360 + i },
      });
    }
    const items = subnetNewsItems({
      netuid: 18,
      hyperparamSnapshots: flood,
      ownershipRows: [OWNERSHIP_ROW],
    });
    // The ownership item survives 60 hyperparameter changes.
    expect(items.some((i) => i.id.startsWith("chain:sn18:owner:"))).toBe(true);
    expect(items.filter((i) => i.id.includes(":hyperparam:")).length).toBe(
      NEWS_CAPS["hyperparam-change"],
    );
  });

  it("is total with no sources at all", () => {
    expect(subnetNewsItems({ netuid: 18 })).toEqual([]);
  });
});

describe("value and timestamp coercion, driven through the public builders", () => {
  it("renders a float parameter without dumping full float noise", () => {
    // min_burn_tao is genuinely fractional (0.0005), unlike the integer params.
    const items = hyperparamChangeItems(64, [
      {
        block_number: 10,
        observed_at: "2026-07-01T00:00:00.000Z",
        hyperparameters: { ...BASE_HYPERPARAMS },
      },
      {
        block_number: 11,
        observed_at: "2026-07-02T00:00:00.000Z",
        hyperparameters: { ...BASE_HYPERPARAMS, min_burn_tao: 0.00123456789 },
      },
    ]);
    expect(items[0].title).toBe("Subnet 64: Minimum burn 0.0005 → 0.00123457");
  });

  it("renders a non-numeric parameter value as-is", () => {
    const items = hyperparamChangeItems(64, [
      {
        block_number: 10,
        observed_at: "2026-07-01T00:00:00.000Z",
        hyperparameters: { ...BASE_HYPERPARAMS, yuma_version: "2" },
      },
      {
        block_number: 11,
        observed_at: "2026-07-02T00:00:00.000Z",
        hyperparameters: { ...BASE_HYPERPARAMS, yuma_version: "3" },
      },
    ]);
    expect(items[0].title).toBe("Subnet 64: Yuma version 2 → 3");
  });

  it("accepts an ISO observed_at as well as epoch-ms", () => {
    // Different tiers return different shapes; both are real.
    const iso = ownershipChangeItems(18, [
      { ...OWNERSHIP_ROW, observed_at: "2026-07-27T13:49:31Z" },
    ]);
    expect(iso[0].timestamp).toBe("2026-07-27T13:49:31.000Z");
  });

  it("drops a row whose observed_at cannot be read at all", () => {
    for (const observedAt of [null, "", "not-a-date", Number.NaN, {}]) {
      expect(
        ownershipChangeItems(18, [
          { ...OWNERSHIP_ROW, observed_at: observedAt },
        ]),
      ).toEqual([]);
    }
  });

  it("survives a row with no args and a short or missing address", () => {
    // args.netuid absent -> the row is not filtered out by netuid, and the
    // addresses degrade to a placeholder rather than throwing.
    const items = ownershipChangeItems(18, [{ ...OWNERSHIP_ROW, args: null }]);
    expect(items).toHaveLength(1);
    expect(items[0].summary).toContain("unknown");

    const short = ownershipChangeItems(18, [
      { ...OWNERSHIP_ROW, args: { old_coldkey: "5Dabc", new_coldkey: 42 } },
    ]);
    expect(short[0].summary).toContain("5Dabc");
  });

  it("tolerates a snapshot row with no hyperparameters object, either side", () => {
    // Both directions: a missing OLDER snapshot object, and a missing NEWER
    // one. Either way there is nothing to compare, so nothing is reported --
    // never "undefined -> 360".
    expect(
      hyperparamChangeItems(64, [
        { block_number: 1, observed_at: "2026-07-01T00:00:00.000Z" } as never,
        {
          block_number: 2,
          observed_at: "2026-07-02T00:00:00.000Z",
          hyperparameters: { ...BASE_HYPERPARAMS },
        },
      ]),
    ).toEqual([]);
    expect(
      hyperparamChangeItems(64, [
        {
          block_number: 1,
          observed_at: "2026-07-01T00:00:00.000Z",
          hyperparameters: { ...BASE_HYPERPARAMS },
        },
        { block_number: 2, observed_at: "2026-07-02T00:00:00.000Z" } as never,
      ]),
    ).toEqual([]);
  });

  it("drops a lease row with an unreadable block or timestamp", () => {
    expect(
      leaseEventItems(18, [
        {
          block_number: 1,
          method: "SubnetLeaseCreated",
          observed_at: "nope",
          args: { netuid: [18] },
        },
      ]),
    ).toEqual([]);
    expect(
      leaseEventItems(18, [
        {
          block_number: "x" as never,
          method: "SubnetLeaseCreated",
          observed_at: 1785294096000,
          args: { netuid: [18] },
        },
      ]),
    ).toEqual([]);
  });

  it("drops a lease row for a different subnet", () => {
    expect(
      leaseEventItems(64, [
        {
          ...OWNERSHIP_ROW,
          method: "SubnetLeaseCreated",
          args: { netuid: [18] },
        },
      ]),
    ).toEqual([]);
  });

  it("cites the extrinsic for a lease event that has one", () => {
    const items = leaseEventItems(18, [
      {
        ...OWNERSHIP_ROW,
        method: "SubnetLeaseCreated",
        args: { netuid: [18] },
        extrinsic_index: 7,
      },
    ]);
    expect(items[0].url).toBe(extrinsicUrl(8724813, 7));
  });

  it("skips a snapshot pair whose newer block number is unreadable", () => {
    expect(
      hyperparamChangeItems(64, [
        HYPERPARAM_SNAPSHOTS[0],
        { ...HYPERPARAM_SNAPSHOTS[1], block_number: "" as never },
      ]),
    ).toEqual([]);
  });
});

describe("timestamp coercion edge cases", () => {
  it("accepts a numeric-string observed_at", () => {
    // Some tiers hand back epoch-ms as a string; Date.parse cannot read it.
    expect(
      ownershipChangeItems(18, [
        { ...OWNERSHIP_ROW, observed_at: "1785294096000" },
      ])[0].timestamp,
    ).toBe(new Date(1785294096000).toISOString());
  });

  it("rejects a timestamp outside the representable Date range", () => {
    // Finite, but beyond ±8.64e15 — toISOString() would throw, which would
    // 500 a whole feed on one corrupt row.
    for (const observedAt of [8.64e15 + 1, "99999999999999999999"]) {
      expect(
        ownershipChangeItems(18, [
          { ...OWNERSHIP_ROW, observed_at: observedAt },
        ]),
      ).toEqual([]);
    }
  });

  it("ignores a lease row whose method is not a string", () => {
    expect(
      leaseEventItems(18, [
        { ...OWNERSHIP_ROW, method: 5 as never, args: { netuid: [18] } },
      ]),
    ).toEqual([]);
  });

  it("falls back to index 0 when a row carries no event_index", () => {
    // Two rows in one block with no index would otherwise collide; the
    // fallback keeps the id constructible and stable.
    const owner = ownershipChangeItems(18, [
      { ...OWNERSHIP_ROW, event_index: undefined },
    ]);
    expect(owner[0].id).toBe("chain:sn18:owner:8724813:0");
    const lease = leaseEventItems(18, [
      {
        ...OWNERSHIP_ROW,
        method: "SubnetLeaseCreated",
        event_index: undefined,
        args: { netuid: [18] },
      },
    ]);
    expect(lease[0].id).toBe("chain:sn18:lease:8724813:0");
  });
});

describe("existing feed items are unaffected (#8658 parity rule)", () => {
  it("the subnet feed's registry and incident items are byte-identical with and without news", async () => {
    // #8704 adds a source to an established feed. Prove the existing items did
    // not shift — same ids, same order among themselves, same bodies — rather
    // than assuming an append is harmless.
    const { handleFeedRequest } = await import("../src/feeds.ts");
    const { mockEnv } = await import("./row-type.ts");
    const CHANGELOG = {
      generated_at: "2026-07-20T00:00:00.000Z",
      subnets: {
        added: [{ netuid: 18, name: "Zeus" }],
        modified: [{ netuid: 18, name: "Zeus" }],
      },
    };
    const readArtifact = async (_env: unknown, path: string) =>
      path === "/metagraph/changelog.json"
        ? { ok: true, data: CHANGELOG }
        : { ok: false };

    async function feedItems(withNews: boolean) {
      const url = new URL(
        "https://api.metagraph.sh/api/v1/feeds/subnets/18.json",
      );
      const res = await handleFeedRequest(new Request(url), mockEnv(), url, {
        readArtifact,
        loadLiveIncidents: async () => null,
        ...(withNews
          ? {
              loadSubnetNews: async () =>
                ownershipChangeItems(18, [OWNERSHIP_ROW]),
            }
          : {}),
      } as never);
      return (JSON.parse(await res.text()) as { items: { id: string }[] })
        .items;
    }

    const before = await feedItems(false);
    const after = await feedItems(true);
    const newsIds = new Set(
      ownershipChangeItems(18, [OWNERSHIP_ROW]).map((i) => i.id),
    );
    // Every pre-existing item survives, byte-identical.
    expect(after.filter((i) => !newsIds.has(i.id))).toEqual(before);
    // ...and the news item actually landed, so this is not passing vacuously.
    expect(after.length).toBe(before.length + newsIds.size);
  });

  it("a failing news source degrades the feed instead of breaking it", async () => {
    const { handleFeedRequest } = await import("../src/feeds.ts");
    const { mockEnv } = await import("./row-type.ts");
    const url = new URL(
      "https://api.metagraph.sh/api/v1/feeds/subnets/18.json",
    );
    const res = await handleFeedRequest(new Request(url), mockEnv(), url, {
      readArtifact: async () => ({ ok: false }),
      loadLiveIncidents: async () => null,
      loadSubnetNews: async () => {
        throw new Error("postgres down");
      },
    } as never);
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).items).toEqual([]);
  });

  it("a news source returning a non-array is ignored", async () => {
    const { handleFeedRequest } = await import("../src/feeds.ts");
    const { mockEnv } = await import("./row-type.ts");
    const url = new URL(
      "https://api.metagraph.sh/api/v1/feeds/subnets/18.json",
    );
    const res = await handleFeedRequest(new Request(url), mockEnv(), url, {
      readArtifact: async () => ({ ok: false }),
      loadLiveIncidents: async () => null,
      loadSubnetNews: async () => null,
    } as never);
    expect(res.status).toBe(200);
  });
});
