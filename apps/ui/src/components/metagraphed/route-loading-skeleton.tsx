import { DataTable, Skeleton, type DataTableColumn } from "@jsonbored/ui-kit";
import { AppShell } from "./app-shell";

const FACT_SKELETONS = ["first", "second", "third"] as const;
type LoadingRow = { key: string };

interface LoadingTable {
  caption: string;
  columns: readonly DataTableColumn<LoadingRow>[];
}

type LoadingEntityKind = "block" | undefined;

const DEFAULT_TABLE: LoadingTable = {
  caption: "Loading records",
  columns: [
    { key: "record", label: "Record", kind: "identifier", lead: true },
    { key: "reading", label: "Reading" },
    { key: "source", label: "Source", kind: "identifier" },
    { key: "status", label: "Status", kind: "status", width: 100 },
  ],
};

const BLOCK_TABLE: LoadingTable = {
  caption: "Extrinsics in this block",
  columns: [
    { key: "hash", label: "Hash", kind: "identifier", width: 150, lead: true },
    { key: "call", label: "Call" },
    { key: "signer", label: "Signer", kind: "identifier" },
    { key: "result", label: "Result", kind: "status", width: 100, align: "right" },
  ],
};

/**
 * The shared first-paint shape for routes whose primary loader has not
 * resolved. It deliberately mirrors the document grammar -- entity hero,
 * ruled fact ledger, then a primary record table -- without pretending that
 * any individual reading or table value is already known.
 *
 * Loading must not invent a second page design. The rendered destination gets
 * the same visual anchors before the query settles, which keeps both the
 * reading order and the mobile reflow stable during slow navigations.
 */
export function DocumentLoadingSkeleton({
  label = "Loading page data",
  table = DEFAULT_TABLE,
  entityKind,
}: {
  label?: string;
  table?: LoadingTable;
  entityKind?: LoadingEntityKind;
}) {
  return (
    <section
      className="mg-page"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">
        <header
          className={`mg-hero mg-hero--entity${entityKind === "block" ? " mg-hero--block" : ""}`}
        >
          <div className="mg-hero-crumbs">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-4 w-16" />
          </div>
          <div className="mg-hero-title">
            <Skeleton className="h-9 w-48 max-w-full sm:h-10 sm:w-56" />
            <div className="mg-hero-actions">
              <Skeleton className="h-8 w-8" />
              <Skeleton className="h-8 w-8" />
            </div>
          </div>
          <Skeleton className="h-4 w-full max-w-[31rem]" />
          <dl className="mg-facts" data-count={FACT_SKELETONS.length}>
            {FACT_SKELETONS.map((key) => (
              <div key={key} className="mg-fact">
                <dt>
                  <Skeleton className="h-3 w-2/5" />
                </dt>
                <dd>
                  <Skeleton className="h-8 w-3/5" />
                </dd>
              </div>
            ))}
          </dl>
          <Skeleton className="h-3 w-44" />
        </header>
      </div>
      <DataTable
        rows={[]}
        columns={table.columns}
        rowKey={(row) => row.key}
        caption={table.caption}
        loading
        mobile="cards"
        source="route-pending"
      />
    </section>
  );
}

/** The router fallback includes the real shell so a slow navigation keeps its navigation context. */
export function RouteLoadingSkeleton({
  label,
  table,
  entityKind,
}: {
  label?: string;
  table?: LoadingTable;
  entityKind?: LoadingEntityKind;
}) {
  return (
    <AppShell chromeOnly>
      <DocumentLoadingSkeleton label={label} table={table} entityKind={entityKind} />
    </AppShell>
  );
}

/** The block route's pending state uses its real primary-ledger geometry, not a generic panel. */
export function BlockDetailLoadingSkeleton() {
  return (
    <RouteLoadingSkeleton label="Loading block detail" table={BLOCK_TABLE} entityKind="block" />
  );
}
