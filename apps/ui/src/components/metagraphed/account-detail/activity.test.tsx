import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiSourceProvider } from "@/lib/metagraphed/api-source-context";
import { MODERN_FINNEY_GENESIS } from "@/lib/metagraphed/modern-catalog";
import { modernAccountKey, type ModernAccountEvents } from "@/lib/metagraphed/modern-explorer";
import { ActivitySection } from "./activity";
import {
  modernExplorerFixture,
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
vi.mock("@/components/metagraphed/router-link", () => ({
  RouterLink: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
const scope = {
  origin: "https://example.test",
  network: "finney",
  genesis: MODERN_FINNEY_GENESIS,
} as const;
const key = modernAccountKey(scope, MODERN_EXPLORER_PARTICIPANT, 0);
const fixture = () =>
  JSON.parse(
    modernExplorerFixture(
      new URL(
        `${scope.origin}/api/v2/networks/finney/accounts/${MODERN_EXPLORER_PARTICIPANT}/events?limit=25`,
      ),
    )!.body,
  ) as ModernAccountEvents;
function render(client: QueryClient, ss58 = MODERN_EXPLORER_ACCOUNT) {
  return renderToStaticMarkup(
    createElement(ApiSourceProvider, {
      children: createElement(
        QueryClientProvider,
        { client },
        createElement(ActivitySection, { ss58 }),
      ),
    }),
  );
}
beforeEach(() => {
  state.configuration = null;
  state.nearViewport = true;
});

describe("qualified account activity rendering", () => {
  it("keeps hydration, unsupported selection and invalid addresses distinct from empty history", () => {
    const client = new QueryClient();
    try {
      expect(render(client)).toContain("Choose your network and API source");
      expect(render(client)).not.toContain("No matching typed account appearances");
      state.configuration = { status: "unsupported-network" };
      expect(render(client)).toContain("No other network was queried");
      state.configuration = { status: "ready", scope };
      expect(render(client, MODERN_EXPLORER_ACCOUNT.slice(0, -1) + "Z")).toContain(
        "No account activity was queried",
      );
      expect(client.getQueryCache().findAll()).toEqual([]);
    } finally {
      client.clear();
    }
  });
  it("defers the table until its viewport signal even when a cached page exists", () => {
    state.configuration = { status: "ready", scope };
    state.nearViewport = false;
    const client = new QueryClient();
    try {
      client.setQueryData(key, { pages: [fixture()], pageParams: [null] });
      const html = render(client);
      expect(html).toContain("mg-dt-skeleton");
      expect(html).not.toContain("18446744073709551615");
    } finally {
      client.clear();
    }
  });
  it("renders exact fields, typed positions, observation coverage and pinned block links", () => {
    state.configuration = { status: "ready", scope };
    const client = new QueryClient();
    const data = fixture();
    try {
      client.setQueryData(key, { pages: [data], pageParams: [null] });
      const html = render(client);
      expect(html).toContain("18446744073709551615");
      expect(html).toContain("#0 field_0");
      expect(html).toContain("#2 field_2");
      expect(html).toContain("Published coverage blocks");
      expect(html).toContain("freshness stale");
      expect(html).toContain(`block_hash=${data.snapshot.block_hash}`);
      expect(html).toContain(`publication_id=${data.snapshot.publication_id}`);
      expect(html).toContain("not economic or authorization roles");
      expect(html).not.toContain("chain-direct");
      expect(html).not.toContain("Any kind");
      expect(html).not.toContain("mg-dt-skeleton");
      expect(html).not.toContain(">Amount<");
    } finally {
      client.clear();
    }
  });
  it("states the covered empty interval without an account lifetime assertion", () => {
    state.configuration = { status: "ready", scope };
    const client = new QueryClient();
    try {
      const data = { ...fixture(), events: [], next_cursor: null };
      client.setQueryData(key, { pages: [data], pageParams: [null] });
      const html = render(client);
      expect(html).toContain("No matching typed account appearances in published coverage blocks");
      expect(html).not.toContain("0 events");
      expect(html).not.toContain('role="alert"');
    } finally {
      client.clear();
    }
  });
  for (const accepted of [false, true]) {
    it(`separates failed acquisition from ${accepted ? "retained accepted rows" : "an empty result"}`, async () => {
      state.configuration = { status: "ready", scope };
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      try {
        if (accepted) client.setQueryData(key, { pages: [fixture()], pageParams: [null] });
        await expect(
          client.fetchInfiniteQuery({
            queryKey: key,
            initialPageParam: null,
            queryFn: async (): Promise<ModernAccountEvents> => {
              throw new Error("controlled unavailable");
            },
            getNextPageParam: () => undefined,
          }),
        ).rejects.toThrow("controlled unavailable");
        const html = render(client);
        expect(html).toContain('role="alert"');
        expect(html).toContain("Published account activity is unavailable");
        expect(html).not.toContain("No matching typed account appearances");
        expect(html.includes("Previously accepted account events retained")).toBe(accepted);
        expect(html.includes("18446744073709551615")).toBe(accepted);
      } finally {
        client.clear();
      }
    });
  }
});
