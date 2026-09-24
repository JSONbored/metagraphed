import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, test, vi } from "vitest";
import { loadSubnetEventSummaryColdTier } from "../src/subnet-event-summary-cold-tier.ts";
import * as indexed from "../src/subnet-indexed-aggregates.ts";
import { nativeAccountRow } from "./helpers/native-account-row.ts";
type Row = Record<string, unknown>;
const reader = vi.spyOn(indexed, "loadIndexedSubnetEventSummaryRows");
beforeEach(() => {
  reader.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("HTTP is forbidden");
    }),
  );
});
const NOW = 1_785_700_000_000;

/** Two kinds, chosen because they differ in exactly the way the merge has to
 * survive: WeightsSet carries no hotkey and no coldkey, StakeAdded carries
 * both. */
const BASE: Row[] = [
  {
    event_kind: "WeightsSet",
    event_count: 9832,
    first_block: 8_550_095,
    last_block: 8_765_613,
    first_observed_at: NOW - 2_000_000,
    last_observed_at: NOW,
  },
  {
    event_kind: "StakeAdded",
    event_count: 8517,
    first_block: 8_550_115,
    last_block: 8_765_646,
    first_observed_at: NOW - 2_000_000,
    last_observed_at: NOW,
    amount_tao: 1234.5,
  },
];
// WeightsSet IS present in the actor read and absent from the coldkey one --
// the asymmetry is the point. Its rows carry no hotkey and no coldkey, but the
// chain event does emit a uid, so the actor identity falls back to that and
// counts real setters; there is no delegating account to fall back to for
// coldkey, so it drops out entirely. Measured live for netuid 64/30d: 15
// setters against 9,830 WeightsSet events.
const HOTKEYS: Row[] = [
  { event_kind: "StakeAdded", n: 66 },
  { event_kind: "WeightsSet", n: 15 },
];
const COLDKEYS: Row[] = [{ event_kind: "StakeAdded", n: 2109 }];
const RECENT: Row[] = [
  {
    block_number: 8_765_646,
    event_index: 3,
    event_kind: "StakeAdded",
    netuid: 64,
    observed_at: NOW,
  },
];

function nativeRows() {
  reader.mockResolvedValue({
    kinds: BASE.map((row) => ({
      ...row,
      hotkey_count:
        HOTKEYS.find((x) => x.event_kind === row.event_kind)?.n ?? 0,
      coldkey_count:
        COLDKEYS.find((x) => x.event_kind === row.event_kind)?.n ?? 0,
    })),
    recent: RECENT.map((row) => nativeAccountRow(row)),
  });
}
describe("native subnet event summary", () => {
  test("retains per-kind totals, UID actors and distinct coldkeys in the public payload", async () => {
    nativeRows();
    const before = Date.now();
    const data = await loadSubnetEventSummaryColdTier({}, 64, {
      window: "30d",
      limit: 10,
    });
    assert.ok(data);
    assert.equal(data.total_events, 18349);
    assert.equal(data.kind_count, 2);
    assert.equal(data.recent_event_count, 1);
    const kinds = Object.fromEntries(
      data.event_kinds.map((k) => [k.event_kind, k]),
    );
    assert.equal(kinds.StakeAdded.hotkey_count, 66);
    assert.equal(kinds.StakeAdded.coldkey_count, 2109);
    assert.equal(kinds.WeightsSet.hotkey_count, 15);
    assert.equal(kinds.WeightsSet.coldkey_count, 0);
    assert.equal(reader.mock.calls[0][1], 64);
    assert.equal(reader.mock.calls[0][3], 10);
    assert.ok(reader.mock.calls[0][2] >= before - 30 * 86400000);
    assert.ok(reader.mock.calls[0][2] <= Date.now() - 30 * 86400000);
  });
  test("declines incomplete coverage and distinguishes a verified empty window", async () => {
    for (const rows of [null, undefined]) {
      reader.mockResolvedValue(rows);
      assert.equal(
        await loadSubnetEventSummaryColdTier({}, 7, { window: "7d" }),
        null,
      );
    }
    reader.mockResolvedValue({ kinds: [], recent: [] });
    const result = await loadSubnetEventSummaryColdTier({}, 7, {
      window: "7d",
    });
    assert.equal(result?.total_events, 0);
    assert.equal(result?.kind_count, 0);
  });
  test("uses the route default for absent and unusable limits", async () => {
    nativeRows();
    for (const limit of [undefined, null, 0, -5, 1.5, NaN]) {
      assert.ok(
        await loadSubnetEventSummaryColdTier({}, 7, { window: "90d", limit }),
      );
      assert.equal(reader.mock.lastCall?.[3], 10);
    }
  });
  test("rejects invalid subnet and window before touching history", async () => {
    for (const netuid of [-1, 1.5, NaN])
      assert.equal(
        await loadSubnetEventSummaryColdTier({}, netuid, { window: "30d" }),
        null,
      );
    for (const window of ["all-time", "1y", ""])
      assert.equal(
        await loadSubnetEventSummaryColdTier({}, 7, { window }),
        null,
      );
    assert.equal(reader.mock.calls.length, 0);
  });
});
describe("all three event-summary surfaces go through the one reader", () => {
  // The regression is a surface wired to the lakehouse while its siblings are
  // not. A call site either exists or it does not.
  const sources = {
    REST: "workers/request-handlers/entities.ts",
    MCP: "src/mcp-server.ts",
    GraphQL: "src/graphql.ts",
  } as const;

  test("every surface calls loadSubnetEventSummaryColdTier", () => {
    for (const [surface, path] of Object.entries(sources)) {
      assert.match(
        readFileSync(path, "utf8"),
        /loadSubnetEventSummaryColdTier\(/,
        `${surface} (${path}) would answer a zeroed card while its siblings ` +
          "answer real numbers",
      );
    }
  });
});
