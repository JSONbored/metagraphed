import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApiResult } from "@/lib/metagraphed/client";
import type {
  ChainIdentityChange,
  ChainIdentityHistory,
  RuntimeVersionHistory,
  EndpointIncident,
} from "@/lib/metagraphed/types";
import {
  changelogQuery,
  chainIdentityHistoryQuery,
  resolvedEndpointIncidentsQuery,
  runtimeVersionHistoryQuery,
} from "@/lib/metagraphed/queries";
import { WhatChangedFeed } from "./what-changed-feed";

// The feed deep-links identity/runtime items through the router's <Link>,
// which cannot render outside a RouterProvider. Everything else from the
// module stays real; only <Link> is swapped for a plain anchor so the digest
// rows themselves render.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const React = await import("react");
  return {
    ...actual,
    Link: ({ children }: { children?: ReactNode }) =>
      React.createElement("a", { href: "#" }, children),
  };
});

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

/** The changelog query's entry type is module-private; this mirrors it. */
type ChangelogEntry = { id: string; at?: string; title?: string; kind?: string };

function wrap<T>(data: T): ApiResult<T> {
  return { data, meta: {}, url: "https://api.metagraph.sh/test" };
}

function identityChange(netuid: number, subnetName: string): ChainIdentityChange {
  return {
    netuid,
    identity_hash: `hash-${netuid}`,
    block_number: 6_500_000 + netuid,
    observed_at: HOUR_AGO,
    subnet_name: subnetName,
    symbol: null,
    description: null,
    github_repo: null,
    subnet_url: null,
    logo_url: null,
    discord: null,
  };
}

function identityHistory(...changes: ChainIdentityChange[]): ApiResult<ChainIdentityHistory> {
  return wrap({
    schema_version: 1,
    count: changes.length,
    subnet_count: new Set(changes.map((c) => c.netuid)).size,
    changes,
  });
}

function runtimeHistory(specVersion: number): ApiResult<RuntimeVersionHistory> {
  return wrap({
    transitions: [{ spec_version: specVersion, block_number: 6_400_000, observed_at: HOUR_AGO }],
    transition_count: 1,
    current_spec_version: specVersion,
    coverage_from_block: null,
    coverage_from_at: null,
  });
}

function seededClient(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(changelogQuery().queryKey, wrap([] as ChangelogEntry[]));
  client.setQueryData(resolvedEndpointIncidentsQuery().queryKey, wrap([] as EndpointIncident[]));
  client.setQueryData(
    chainIdentityHistoryQuery(50).queryKey,
    identityHistory(identityChange(42, "Alpha Origins")),
  );
  client.setQueryData(runtimeVersionHistoryQuery().queryKey, runtimeHistory(271));
  return client;
}

function render(client: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <WhatChangedFeed />
    </QueryClientProvider>,
  );
}

// #8558: the digest memo depended on `identity`/`runtime` values built with a
// render-scope `?? []` fallback -- an unstable identity that tripped
// react-hooks/exhaustive-deps and defeated the memo. The fix keeps the two
// chain-side query RESULTS as the reactive inputs. These tests pin the
// behaviour that rearrangement must preserve: the feed actually renders from
// those two dependencies, and it reflects their current value -- not a stale
// capture -- when the underlying query data changes.
describe("WhatChangedFeed chain-side dependencies (#8558)", () => {
  it("renders identity and runtime digest items sourced from the two non-suspending queries", () => {
    const markup = render(seededClient());
    expect(markup).toContain("Alpha Origins updated its on-chain identity");
    expect(markup).toContain("Runtime upgraded to spec 271");
  });

  it("reflects a change in the chain-identity source instead of a stale capture", () => {
    const client = seededClient();
    const first = render(client);
    expect(first).toContain("Alpha Origins updated its on-chain identity");
    expect(first).not.toContain("Beta Rising");

    client.setQueryData(
      chainIdentityHistoryQuery(50).queryKey,
      identityHistory(identityChange(42, "Alpha Origins"), identityChange(7, "Beta Rising")),
    );

    const second = render(client);
    expect(second).toContain("Alpha Origins updated its on-chain identity");
    expect(second).toContain("Beta Rising updated its on-chain identity");
  });

  it("falls back to empty chain-side sources without blanking the suspense-backed digest", () => {
    // The `?? []` fallback now lives inside the memo: with the two chain-side
    // caches empty the feed must still render (the queries are deliberately
    // non-suspending) rather than crash or blank.
    const client = new QueryClient();
    client.setQueryData(changelogQuery().queryKey, wrap([] as ChangelogEntry[]));
    client.setQueryData(resolvedEndpointIncidentsQuery().queryKey, wrap([] as EndpointIncident[]));
    const markup = render(client);
    expect(markup).toContain("Recent registry signal");
    expect(markup).not.toContain("updated its on-chain identity");
  });
});
