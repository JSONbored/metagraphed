import { lazy, Suspense } from "react";
import { ClientOnly } from "@tanstack/react-router";

const GraphiqlExplorerBody = lazy(() =>
  import("./graphiql-explorer-body").then((m) => ({ default: m.GraphiqlExplorerBody })),
);

export interface GraphiqlExplorerProps {
  endpoint: string;
}

export function GraphiqlExplorer({ endpoint }: GraphiqlExplorerProps) {
  return (
    <ClientOnly fallback={<ExplorerFallback />}>
      <Suspense fallback={<ExplorerFallback />}>
        <GraphiqlExplorerBody endpoint={endpoint} />
      </Suspense>
    </ClientOnly>
  );
}

function ExplorerFallback() {
  return (
    <div className="flex h-[640px] items-center justify-center rounded-lg border border-border bg-card font-mono text-xs text-ink-muted">
      Loading explorer…
    </div>
  );
}
