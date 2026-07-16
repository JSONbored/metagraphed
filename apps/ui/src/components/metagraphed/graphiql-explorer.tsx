import { lazy, Suspense } from "react";
import { ClientOnly } from "@tanstack/react-router";
import { classNames } from "@/lib/metagraphed/format";

const GraphiqlExplorerBody = lazy(() =>
  import("./graphiql-explorer-body").then((m) => ({ default: m.GraphiqlExplorerBody })),
);

const DEFAULT_HEIGHT_CLASSNAME = "h-[460px] md:h-[540px] lg:h-[640px]";

export interface GraphiqlExplorerProps {
  endpoint: string;
  /** Tailwind height classes; overrides the compact docs-embed default. */
  heightClassName?: string;
}

export function GraphiqlExplorer({ endpoint, heightClassName }: GraphiqlExplorerProps) {
  const height = heightClassName ?? DEFAULT_HEIGHT_CLASSNAME;
  return (
    <ClientOnly fallback={<ExplorerFallback heightClassName={height} />}>
      <Suspense fallback={<ExplorerFallback heightClassName={height} />}>
        <GraphiqlExplorerBody endpoint={endpoint} heightClassName={height} />
      </Suspense>
    </ClientOnly>
  );
}

function ExplorerFallback({ heightClassName }: { heightClassName: string }) {
  return (
    <div
      className={classNames(
        "flex items-center justify-center rounded-lg border border-border bg-card font-mono text-xs text-ink-muted",
        heightClassName,
      )}
    >
      Loading explorer…
    </div>
  );
}
