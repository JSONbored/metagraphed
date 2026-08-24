import type { ReactNode } from "react";
import { EntityHero, FactSentence, Raw, type RawRow } from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState } from "@/components/metagraphed/states";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { factCells } from "@/lib/metagraphed/facts";
import type { Fact as StreamFact } from "./chain-stream-logic";

/**
 * Registration has to happen INSIDE `AppShell`, which is where the provider
 * is: calling `useRegisterApiSource` in `StreamShell`'s own body runs the hook
 * one level above the provider it needs, and the page renders
 * "useApiSourceCtx must be used within ApiSourceProvider" instead of itself.
 * A null-rendering child is the smallest thing that sits on the right side of
 * that boundary -- the same shape `-explorer-page.tsx` uses.
 */
function ApiSources({
  paths,
  artifacts,
}: {
  paths: readonly string[];
  artifacts: readonly string[];
}) {
  useRegisterApiSource([...paths], [...artifacts]);
  return null;
}

/** The push counterpart to these three polling pages. */
const CHAIN_STREAM_PATH = "/api/v1/chain/stream";

export function StreamShell({
  name,
  lede,
  facts,
  updatedAt,
  refreshing,
  onRefresh,
  apiPaths,
  artifacts = [],
  children,
}: {
  name: string;
  lede: string;
  facts: readonly StreamFact[];
  updatedAt: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  apiPaths: readonly string[];
  artifacts?: readonly string[];
  children: ReactNode;
}) {
  const rawRows: RawRow[] = [
    ...apiPaths.map((path) => ({
      label: path.replace("/api/v1/", ""),
      value: `${API_BASE}${path}`,
      href: `${API_BASE}${path}`,
    })),
    ...artifacts.map((path) => ({
      label: `artifact ${path.replace("/metagraph/", "")}`,
      value: `${API_BASE}${path}`,
      href: `${API_BASE}${path}`,
    })),
    // The same activity as a live feed. These three pages poll; a reader who
    // wants it pushed has the SSE endpoint here rather than only in the API
    // reference, which is where it had ended up once the app's own
    // `use-chain-stream` hook went unused and was deleted (#11628).
    {
      label: "stream (SSE)",
      value: `${API_BASE}${CHAIN_STREAM_PATH}`,
      href: `${API_BASE}${CHAIN_STREAM_PATH}`,
    },
  ];
  return (
    <AppShell>
      <ApiSources paths={apiPaths} artifacts={artifacts} />
      <EntityHero
        crumbs={[{ label: "Chain", href: "/chain" }]}
        name={name}
        sentence={<FactSentence>{lede}</FactSentence>}
        // A STRIP, not chips (#11696). All three of these pages are a table
        // with a sentence over it, and the sentence set the head block, the
        // block time and the Nakamoto coefficient at 11px -- smaller than the
        // table's own rows. The lede stays prose; the numbers get cells.
        cells={factCells(facts) ?? undefined}
        live={{ updatedAt, source: "chain-direct", onRefresh, refreshing }}
      />
      {children}
      <Raw rows={rawRows} />
    </AppShell>
  );
}

/**
 * The empty state, which is two different answers wearing one word (#6340).
 *
 * "Nothing matched your filters" and "this feed has nothing in it" call for
 * different copy and, crucially, different actions: the API link belongs only
 * on the second. Offering it on a filtered-empty view sends the reader to the
 * UNFILTERED endpoint, which will be full — the page then looks like it lied.
 */
export function streamEmpty(filtersActive: boolean, subject: string, path: string) {
  return filtersActive ? (
    <EmptyState
      title={`No ${subject} match these filters`}
      description="Clear a filter to widen the feed."
    />
  ) : (
    <EmptyState
      title={`No ${subject} indexed yet`}
      description="This feed is built from chain state; it fills in as the capture runs."
      action={{ label: `Open ${path}`, href: `${API_BASE}${path}`, external: true }}
    />
  );
}
