import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiSourceProvider } from "@/lib/metagraphed/api-source-context";
import { encodeSs58 } from "@/lib/metagraphed/ss58";
import { MODERN_FINNEY_GENESIS } from "@/lib/metagraphed/modern-catalog";
import { modernStakeKey, type ModernAccountStake } from "@/lib/metagraphed/modern-explorer";
import { PositionsSection } from "./positions";
import {
  modernStakeFixture,
  MODERN_EXPLORER_ACCOUNT,
  MODERN_EXPLORER_PARTICIPANT,
} from "../../../../tests/e2e/modern-explorer-fixture";

const state = vi.hoisted(() => ({ configuration: null as unknown, nearViewport: true }));
vi.mock("@/lib/metagraphed/modern-explorer", async (original) => ({
  ...(await original<typeof import("@/lib/metagraphed/modern-explorer")>()),
  useModernExplorerConfiguration: () => state.configuration,
}));
vi.mock("@/hooks/use-near-viewport", () => ({
  useNearViewport: () => ({ nearViewport: state.nearViewport, ref: { current: null } }),
}));
const scope = {
  origin: "https://example.test",
  network: "finney",
  genesis: MODERN_FINNEY_GENESIS,
} as const;
const account = MODERN_EXPLORER_PARTICIPANT;
const key = modernStakeKey(scope, account, 0);
function render(client: QueryClient, ss58 = MODERN_EXPLORER_ACCOUNT) {
  return renderToStaticMarkup(
    createElement(ApiSourceProvider, {
      children: createElement(
        QueryClientProvider,
        { client },
        createElement(PositionsSection, { ss58 }),
      ),
    }),
  );
}
function record(client: QueryClient, pages: ModernAccountStake[], accountId = account) {
  client.setQueryData(modernStakeKey(scope, accountId, 0), {
    pages,
    pageParams: pages.map((_, i) => (i === 0 ? null : { cursor: pages[i - 1].next_cursor })),
  });
}
beforeEach(() => {
  state.configuration = null;
  state.nearViewport = true;
});
describe("published account positions and entitlements", () => {
  it("keeps pending configuration unsupported scope and invalid checksum distinct from covered emptiness", () => {
    const client = new QueryClient();
    try {
      expect(render(client)).toContain("Choose your network and API source");
      expect(render(client)).not.toContain("No stake positions or root entitlements");
      state.configuration = { status: "unsupported-network" };
      expect(render(client)).toContain("No other network was queried");
      state.configuration = { status: "ready", scope };
      expect(render(client, MODERN_EXPLORER_ACCOUNT.slice(0, -1) + "Z")).toContain(
        "No account stake was queried",
      );
      expect(client.getQueryCache().findAll()).toEqual([]);
    } finally {
      client.clear();
    }
  });
  it("retains viewport loading geometry instead of displaying cached amounts prematurely", () => {
    state.configuration = { status: "ready", scope };
    state.nearViewport = false;
    const client = new QueryClient();
    try {
      record(client, [modernStakeFixture(account)]);
      const html = render(client);
      expect(html).toContain("mg-dt-skeleton");
      expect(html).not.toContain("18446744073709551615");
    } finally {
      client.clear();
    }
  });
  it("renders exact root quantities and separate entitlements without a global account total or floating valuation", () => {
    state.configuration = { status: "ready", scope };
    const client = new QueryClient();
    try {
      const first = modernStakeFixture(account);
      const second = modernStakeFixture(account, first.next_cursor!);
      record(client, [first, second]);
      const html = render(client);
      expect(html).toContain("18446744073709551615 rao");
      expect(html).toContain("Root entitlement");
      expect(html).toContain("No current position · retired");
      expect(html).toContain("Loaded 14 position records and 1 root entitlement records");
      expect(html).not.toContain("Loaded 100");
      expect(html).not.toContain("200 root");
      expect(html).toContain("49 rao deferred cash");
      expect(html).toContain("fund generations");
      expect(html).toContain("source_reviewed_candidate");
      expect(html).toContain("freshness stale");
      expect(html).toContain("Liquid balances and combined TAO valuation are not supplied");
      expect(html).toContain("must not be added together");
      expect(html).not.toContain("Share of holdings");
      expect(html).not.toContain("Apex");
      expect(html).not.toContain("chain-direct");
      expect(html).not.toContain("mg-dt-skeleton");
    } finally {
      client.clear();
    }
  });
  it("preserves exact zero and absent states and residual asset identity", () => {
    state.configuration = { status: "ready", scope };
    const client = new QueryClient();
    try {
      const page = modernStakeFixture(account);
      const template = page.entries.find((entry) => entry.kind === "position");
      if (template?.kind !== "position") throw new Error("Fixture position missing");
      const zero = structuredClone(template);
      zero.position.assessment.share_state = "zero";
      zero.position.assessment.member = { encoding: "safe_float_v2", mantissa: "0", exponent: "0" };
      zero.position.quote = { status: "exact", basis: { kind: "root_tao" }, atomic_units: "0" };
      const absent = structuredClone(template);
      absent.position.hotkey = `0x${"2".repeat(64)}`;
      absent.position.assessment.share_state = "absent";
      absent.position.assessment.member = null;
      absent.position.quote = { status: "no_current_position", state: "absent" };
      const residual = structuredClone(template);
      residual.position.hotkey = `0x${"3".repeat(64)}`;
      residual.position.netuid = 7;
      residual.position.subnet = { status: "residual_storage", generation: null };
      residual.position.asset = {
        kind: "subnet_alpha",
        genesis_hash: scope.genesis,
        netuid: 7,
        registration_counter: null,
        unit: "alpha_atomic",
      };
      residual.position.quote = {
        status: "exact",
        basis: { kind: "subnet_alpha", netuid: 7 },
        atomic_units: "9007199254740993",
      };
      record(client, [{ ...page, entries: [zero, absent, residual], next_cursor: null }]);
      const html = render(client);
      expect(html).toContain("0 rao · zero");
      expect(html).toContain("No current position · absent");
      expect(html).toContain("9007199254740993 alpha_atomic");
      expect(html).toContain("residual storage; generation unavailable");
    } finally {
      client.clear();
    }
  });
  it("keeps claim-only cash and signed watermarks without inventing a principal position", () => {
    state.configuration = { status: "ready", scope };
    const client = new QueryClient();
    const owner = `0x${"b".repeat(64)}`;
    const ss58 = encodeSs58(new Uint8Array(32).fill(0xbb), 42)!;
    try {
      record(client, [modernStakeFixture(owner)], owner);
      const html = render(client, ss58);
      expect(html).toContain("Loaded 0 position records and 1 root entitlement records");
      expect(html).toContain("No root principal entry in the complete census");
      expect(html).toContain("9 rao deferred cash");
      expect(html).toContain("-37");
      expect(html).toContain("-9");
      expect(html).not.toContain("No stake positions or root entitlements");
    } finally {
      client.clear();
    }
  });
  it("labels protocol custody without personal claimable quantities", () => {
    state.configuration = { status: "ready", scope };
    const client = new QueryClient();
    const owner = "0x6d6f646c73756274656e7372626574612f657363000000000000000000000000";
    const bytes = Uint8Array.from(owner.slice(2).match(/../g)!, (value) => parseInt(value, 16));
    const ss58 = encodeSs58(bytes, 42)!;
    try {
      const page = modernStakeFixture(owner);
      const root = page.entries.find((entry) => entry.kind === "root_entitlement");
      if (root?.kind !== "root_entitlement") throw new Error("Fixture claimant missing");
      root.entitlement.outcome = { status: "protocol_custody" };
      record(client, [{ ...page, entries: [root], next_cursor: null }], owner);
      const html = render(client, ss58);
      expect(html).toContain("Protocol custody");
      expect(html).not.toContain("rao deferred cash");
      expect(html).not.toContain("claimable balance");
    } finally {
      client.clear();
    }
  });
  it("describes a covered empty coldkey only after a complete census response", () => {
    state.configuration = { status: "ready", scope };
    const client = new QueryClient();
    try {
      const page = modernStakeFixture(account);
      record(client, [{ ...page, entries: [], next_cursor: null }]);
      const html = render(client);
      expect(html).toContain(
        "No stake positions or root entitlements for this coldkey in the published complete census",
      );
      expect(html).not.toContain('role="alert"');
    } finally {
      client.clear();
    }
  });
  for (const accepted of [false, true])
    it(`keeps acquisition failure distinct from ${accepted ? "retained records" : "an empty result"}`, async () => {
      state.configuration = { status: "ready", scope };
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      try {
        if (accepted) record(client, [modernStakeFixture(account)]);
        await expect(
          client.fetchInfiniteQuery({
            queryKey: key,
            initialPageParam: null,
            queryFn: async (): Promise<ModernAccountStake> => {
              throw new Error("controlled unavailable");
            },
            getNextPageParam: () => undefined,
          }),
        ).rejects.toThrow("controlled unavailable");
        const html = render(client);
        expect(html).toContain('role="alert"');
        expect(html).toContain("Published account stake is unavailable");
        expect(html).not.toContain("No stake positions or root entitlements");
        expect(html.includes("Previously accepted stake records retained")).toBe(accepted);
        expect(html.includes("18446744073709551615")).toBe(accepted);
      } finally {
        client.clear();
      }
    });
});
