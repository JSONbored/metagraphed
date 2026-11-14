import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODERN_FINNEY_GENESIS } from "@/lib/metagraphed/modern-catalog";
import { modernExplorerKey } from "@/lib/metagraphed/modern-explorer";
import { ApiSourceProvider } from "@/lib/metagraphed/api-source-context";
import {
  modernExplorerFixture,
  MODERN_EXPLORER_HEIGHT,
  MODERN_EXPLORER_PARTICIPANT,
} from "../../tests/e2e/modern-explorer-fixture";

const state = vi.hoisted(() => ({
  ref: "123",
  search: {} as Record<string, string>,
  configuration: null as unknown,
}));
vi.mock("./blocks.$ref", () => ({
  Route: { useParams: () => ({ ref: state.ref }), useSearch: () => state.search },
}));
vi.mock("@/lib/metagraphed/modern-explorer", async (original) => ({
  ...(await original<typeof import("@/lib/metagraphed/modern-explorer")>()),
  useModernExplorerConfiguration: () => state.configuration,
}));
vi.mock("@/components/metagraphed/app-shell", () => ({
  AppShell: ({ children }: { children: ReactNode }) =>
    createElement(ApiSourceProvider, { children }),
}));
vi.mock("@/components/metagraphed/router-link", () => ({
  RouterLink: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
import { BlockDetailPage } from "./-block-detail-page";
import { chainAccountHref } from "@/lib/metagraphed/accounts";

const scope = {
  origin: "https://example.test",
  network: "finney",
  genesis: MODERN_FINNEY_GENESIS,
} as const;
beforeEach(() => {
  state.ref = "123";
  state.search = {};
  state.configuration = null;
});
describe("published block detail rendering", () => {
  it("renders a hydration boundary without querying a default source", () => {
    const html = renderToStaticMarkup(createElement(BlockDetailPage));
    expect(html).toContain("Choose your network and API source");
    expect(html).not.toContain("Authored by");
  });
  it("explains unsupported networks and malformed publication pins", () => {
    state.configuration = { status: "unsupported-network" };
    expect(renderToStaticMarkup(createElement(BlockDetailPage))).toContain(
      "No other network was queried",
    );
    state.configuration = { status: "ready", scope };
    state.search = { publication_id: "a".repeat(64) };
    expect(renderToStaticMarkup(createElement(BlockDetailPage))).toContain(
      "complete hash/publication pin",
    );
  });
  it("renders accepted provenance, exact decoded quantities, phase, origin, topics and participants", () => {
    state.configuration = { status: "ready", scope };
    state.ref = MODERN_EXPLORER_HEIGHT;
    const value = JSON.parse(
      modernExplorerFixture(new URL(`${scope.origin}/api/v2/networks/finney/blocks/${state.ref}`))!
        .body,
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(
      [...modernExplorerKey(scope, 0), "block", state.ref, undefined, undefined],
      value,
    );
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(BlockDetailPage)),
    );
    expect(html).toContain(MODERN_EXPLORER_HEIGHT);
    expect(html).toContain("Source capture digest");
    expect(html).toContain("ApplyExtrinsic");
    expect(html).toContain("Originating extrinsic #0");
    expect(html).toContain(MODERN_EXPLORER_PARTICIPANT);
    expect(html).toContain("field_0");
    expect(html).toContain(`href="${chainAccountHref(MODERN_EXPLORER_PARTICIPANT)}"`);
    expect(html).toContain("18446744073709551615");
    expect(html).toContain("Topics:");
    expect(html).toContain("does not establish current chain freshness");
    expect(html).not.toContain("Economic footprint");
    client.clear();
  });
});
