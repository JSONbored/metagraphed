import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildUnifiedPositions } from "./your-positions-panel";

// #5243: the "your positions" panel folds the two position feeds (hotkey-owned
// portfolio + coldkey-delegated nominator positions) into one list, deriving
// each alpha holding from the per-subnet price so a slippage-aware exit quote
// can be requested. buildUnifiedPositions is the pure core of that.
describe("buildUnifiedPositions (#5243)", () => {
  const prices = new Map<number, number>([
    [1, 0.5],
    [2, 2],
  ]);

  it("merges owned + delegated feeds, sorted by spot value descending", () => {
    const rows = buildUnifiedPositions(
      [{ netuid: 1, uid: 5, stake_tao: 10, yield: 0.03 }],
      [{ netuid: 2, hotkey: "5Gvalidator", stake_tao: 40 }],
      prices,
    );
    expect(rows.map((r) => [r.source, r.netuid, r.spotTao])).toEqual([
      ["delegated", 2, 40],
      ["owned", 1, 10],
    ]);
  });

  it("derives alpha = spot / price for alpha subnets, carrying owned yield", () => {
    const [owned] = buildUnifiedPositions(
      [{ netuid: 1, uid: 5, stake_tao: 10, yield: 0.03 }],
      [],
      prices,
    );
    expect(owned.alpha).toBe(20); // 10 / 0.5
    expect(owned.yield).toBe(0.03);
    expect(owned.isRoot).toBe(false);
  });

  it("treats root (netuid 0) as TAO 1:1 — no alpha, no exit quote", () => {
    const [root] = buildUnifiedPositions([{ netuid: 0, uid: 1, stake_tao: 7 }], [], prices);
    expect(root.isRoot).toBe(true);
    expect(root.alpha).toBeNull();
  });

  it("leaves alpha null when the subnet price is unknown or non-positive", () => {
    const rows = buildUnifiedPositions(
      [
        { netuid: 9, uid: 1, stake_tao: 5 }, // no price entry
        { netuid: 1, uid: 2, stake_tao: 5 },
      ],
      [],
      new Map([
        [1, 0],
        [9, undefined as unknown as number],
      ]),
    );
    for (const r of rows) expect(r.alpha).toBeNull();
  });

  it("delegated positions carry the validator hotkey and no yield", () => {
    const [d] = buildUnifiedPositions([], [{ netuid: 1, hotkey: "5Gval", stake_tao: 3 }], prices);
    expect(d.hotkey).toBe("5Gval");
    expect(d.yield).toBeNull();
    expect(d.source).toBe("delegated");
  });
});

const routeSrc = readFileSync(
  fileURLToPath(new URL("../../routes/portfolio.tsx", import.meta.url)),
  "utf8",
);
const panelSrc = readFileSync(fileURLToPath(new URL("./your-positions-panel.tsx", import.meta.url)), "utf8");

describe("portfolio route + panel wiring (#5243)", () => {
  it("gates the whole view behind a connected wallet", () => {
    expect(routeSrc).toContain("useWallet()");
    expect(routeSrc).toContain("<WalletConnectButton />");
    expect(routeSrc).toContain("wallet ? (");
  });

  it("sources both position feeds and the exit-quote endpoint", () => {
    expect(panelSrc).toContain("accountPortfolioQuery(address)");
    expect(panelSrc).toContain("accountPositionsQuery(address)");
    expect(panelSrc).toContain('subnetStakeQuoteQuery(p.netuid, p.alpha, "unstake")');
  });

  it("offers a per-position Manage (unstake/move-stake) entry via the shared modal", () => {
    expect(panelSrc).toContain("<StakeUnstakeModal");
    expect(panelSrc).toContain("ManageButton");
  });
});
