import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadIndexedAccountFeedGroups } from "../src/indexed-account-feeds.ts";
import {
  loadAccountStakeFlowColdTier,
  loadAccountStakeMovesColdTier,
  loadAccountRegistrationsColdTier,
  loadAccountServingColdTier,
  loadAccountPrometheusColdTier,
} from "../src/account-feeds-cold-tier.ts";
import { buildAccountStakeFlow } from "../src/account-stake-flow.ts";
import {
  buildAccountStakeMoves,
  declineAccountStakeMoves,
} from "../src/account-stake-moves.ts";
import { buildAccountRegistrations } from "../src/account-registrations.ts";
import { buildAccountServing } from "../src/account-serving.ts";
import { buildAccountPrometheus } from "../src/account-prometheus.ts";
import type { AccountFeedGroup } from "../src/history-account-feed-groups.ts";

vi.mock("../src/indexed-account-feeds.ts", () => ({
  loadIndexedAccountFeedPage: vi.fn(),
  loadIndexedAccountFeedGroups: vi.fn(),
}));
const read = vi.mocked(loadIndexedAccountFeedGroups);
const address = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const now = Date.parse("2026-09-23T12:00:00Z"),
  cutoff = now - 7 * 86400000;
const group: AccountFeedGroup = {
  event_kind: "StakeAdded",
  netuid: 7,
  event_count: 6001,
  total_tao: null,
  total_alpha: 30,
  first_block: 10,
  last_block: 20,
  first_observed: cutoff,
  last_observed: now,
};
const env = {};
beforeEach(() => {
  read.mockReset();
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected SQL request");
    }),
  );
});

describe("indexed account window aggregates", () => {
  it("preserves stake-flow directions, complete counts, alpha and null-sum semantics", async () => {
    for (const direction of ["all", "in", "out"] as const) {
      const kinds =
        direction === "in"
          ? ["StakeAdded"]
          : direction === "out"
            ? ["StakeRemoved"]
            : ["StakeAdded", "StakeRemoved"];
      const rows = kinds.map((event_kind) => ({ ...group, event_kind }));
      read.mockResolvedValue(rows);
      expect(
        await loadAccountStakeFlowColdTier(env, address, {
          window: "7d",
          direction,
        }),
      ).toEqual({
        data: buildAccountStakeFlow(
          rows.map((row) => ({ ...row, total_tao: 0 })),
          address,
          { window: "7d" },
        ),
        generatedAt: new Date(now).toISOString(),
        rows,
      });
      expect(read).toHaveBeenLastCalledWith(
        env,
        kinds.flatMap((kind) =>
          ["hotkey", "coldkey"].map((side) => ({
            side,
            account: address,
            kind,
            observedStart: cutoff,
          })),
        ),
      );
    }
    read.mockResolvedValue([{ ...group, total_tao: 4 }]);
    expect(
      (await loadAccountStakeFlowColdTier(env, address, { window: "7d" }))
        ?.data,
    ).toEqual(
      buildAccountStakeFlow([{ ...group, total_tao: 4 }], address, {
        window: "7d",
      }),
    );
    read.mockResolvedValue([]);
    expect(
      await loadAccountStakeFlowColdTier(env, address, { window: "7d" }),
    ).toEqual({
      data: buildAccountStakeFlow([], address, { window: "7d" }),
      generatedAt: null,
      rows: [],
    });
    read.mockResolvedValue(null);
    expect(
      await loadAccountStakeFlowColdTier(env, address, { window: "7d" }),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps window builders and hotkey-only attribution without a SQL request", async () => {
    const cases = [
      {
        kind: "StakeMoved",
        field: "movements",
        load: loadAccountStakeMovesColdTier,
        build: (rows: AccountFeedGroup[]) =>
          buildAccountStakeMoves(rows, address, { window: "7d" }),
        sides: ["hotkey", "coldkey"],
      },
      {
        kind: "NeuronRegistered",
        field: "registrations",
        load: loadAccountRegistrationsColdTier,
        build: (rows: AccountFeedGroup[]) =>
          buildAccountRegistrations(rows, address, { window: "7d" }),
        sides: ["hotkey"],
      },
      {
        kind: "AxonServed",
        field: "announcements",
        load: loadAccountServingColdTier,
        build: (rows: AccountFeedGroup[]) =>
          buildAccountServing(rows, address, { window: "7d" }),
        sides: ["hotkey"],
      },
      {
        kind: "PrometheusServed",
        field: "announcements",
        load: loadAccountPrometheusColdTier,
        build: (rows: AccountFeedGroup[]) =>
          buildAccountPrometheus(rows, address, {
            window: "7d",
            sourceAvailable: true,
          }),
        sides: ["hotkey"],
      },
    ];
    for (const { kind, field, load, build, sides } of cases) {
      const row = { ...group, event_kind: kind };
      read.mockResolvedValue([row]);
      expect(await load(env, address, { window: "7d" })).toEqual({
        data: build([{ ...row, [field]: row.event_count }]),
        generatedAt: new Date(now).toISOString(),
      });
      expect(read).toHaveBeenLastCalledWith(
        env,
        sides.map((side) => ({
          side,
          account: address,
          kind,
          observedStart: cutoff,
        })),
      );
      read.mockResolvedValue([]);
      expect(await load(env, address, { window: "7d" })).toEqual({
        data: build([]),
        generatedAt: null,
      });
      read.mockResolvedValue(null);
      expect(await load(env, address, { window: "7d" })).toEqual(
        kind === "StakeMoved"
          ? { data: declineAccountStakeMoves(address, "7d"), generatedAt: null }
          : null,
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
