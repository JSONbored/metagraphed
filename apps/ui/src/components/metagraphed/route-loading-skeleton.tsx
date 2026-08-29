import { DataTable, Skeleton, type DataTableColumn } from "@jsonbored/ui-kit";
import type { ReactNode } from "react";
import { AppShell } from "./app-shell";

const FACT_SKELETONS = ["first", "second", "third"] as const;
const DIRECTORY_FACT_SKELETONS = ["first", "second", "third", "fourth"] as const;
const OPERATIONAL_FACT_SKELETONS = ["first", "second", "third", "fourth", "fifth"] as const;
const READING_LINES = ["first", "second", "third", "fourth", "fifth", "sixth"] as const;

type LoadingRow = { key: string };

interface LoadingTable {
  caption: string;
  columns: readonly DataTableColumn<LoadingRow>[];
}

export type RouteLoadingArchetype =
  "landing" | "directory" | "entity" | "operational" | "compare" | "settings" | "reading" | "block";

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

function normalisePathname(pathname: string): string {
  const withoutQuery = pathname.split(/[?#]/, 1)[0] || "/";
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, "") : withoutQuery;
}

/**
 * Return the visual grammar for the destination that is loading.
 *
 * This intentionally accepts a pathname rather than a route id: the default
 * pending component is mounted while TanStack Router is moving between match
 * trees, and `location.pathname` is the stable description of the destination
 * in both client navigation and a direct request.
 */
export function routeLoadingArchetype(pathname: string): RouteLoadingArchetype {
  const path = normalisePathname(pathname);

  if (path === "/") return "landing";
  if (/^\/blocks\/[^/]+$/.test(path)) return "block";
  if (/^\/(subnets|validators|accounts|providers|extrinsics)\/[^/]+$/.test(path)) {
    return "entity";
  }
  if (path === "/compare") return "compare";
  if (path === "/settings" || path === "/portfolio") return "settings";
  if (path === "/agents" || path === "/graphql/explorer") return "settings";
  if (
    path === "/chain" ||
    path === "/health" ||
    path === "/status" ||
    path === "/explorer" ||
    /^\/chain\/(analytics|emissions|governance|runtime)$/.test(path) ||
    /^\/(admin-changes|runtime|sudo)$/.test(path)
  ) {
    return "operational";
  }
  if (
    /^\/(subnets|validators|accounts)$/.test(path) ||
    /^\/subnets\/(category(?:\/[^/]+)?|with-api)$/.test(path) ||
    /^\/apis(?:\/(endpoints|providers|schemas))?$/.test(path) ||
    /^\/chain\/(blocks|events|extrinsics)$/.test(path) ||
    /^\/(blocks|events|extrinsics|providers|endpoints|schemas|surfaces)$/.test(path) ||
    /^\/(contribute|gaps|revenue|leaderboards|domains)$/.test(path)
  ) {
    return "directory";
  }
  return "reading";
}

function PendingDocument({
  label,
  className = "mg-page",
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={className}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
      data-loading-archetype=""
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </section>
  );
}

function LoadingHero({
  variant,
  facts = FACT_SKELETONS,
  block = false,
}: {
  variant: "directory" | "entity" | "operational" | "compare" | "settings";
  facts?: readonly string[];
  block?: boolean;
}) {
  const factClass = variant === "operational" ? " mg-hero--chain" : "";
  return (
    <header className={`mg-hero mg-hero--${variant}${factClass}${block ? " mg-hero--block" : ""}`}>
      {variant === "entity" || variant === "directory" ? (
        <div className="mg-hero-crumbs">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-16" />
        </div>
      ) : null}
      <div className="mg-hero-title">
        <Skeleton className="h-9 w-48 max-w-full sm:h-10 sm:w-56" />
        {variant === "compare" || variant === "settings" ? (
          <Skeleton className="h-9 w-40 max-w-full" />
        ) : variant === "entity" ? (
          <div className="mg-hero-actions">
            <Skeleton className="h-8 w-8" />
            <Skeleton className="h-8 w-8" />
          </div>
        ) : null}
      </div>
      <Skeleton className="h-4 w-full max-w-[34rem]" />
      {variant !== "compare" && variant !== "settings" ? (
        <dl className="mg-facts" data-count={facts.length}>
          {facts.map((key) => (
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
      ) : null}
      {variant !== "compare" && variant !== "settings" ? <Skeleton className="h-3 w-44" /> : null}
    </header>
  );
}

function LoadingTableView({ table = DEFAULT_TABLE }: { table?: LoadingTable }) {
  return (
    <DataTable
      rows={[]}
      columns={table.columns}
      rowKey={(row) => row.key}
      caption={table.caption}
      loading
      mobile="cards"
      source="route-pending"
    />
  );
}

function LandingLoadingSkeleton({ label }: { label: string }) {
  return (
    <PendingDocument label={label} className="mg-page mg-home">
      <header className="mg-home-hero">
        <div className="mg-home-command-grid">
          <div className="mg-home-intro">
            <Skeleton className="h-24 w-64 max-w-full" />
            <div className="mt-[18px] grid w-full max-w-[34rem] gap-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </div>
            <Skeleton className="mt-[30px] h-[52px] w-full max-w-[35rem]" />
            <div className="mg-home-mcp-install">
              <div className="mg-home-mcp-head">
                <div className="mg-home-mcp-identity">
                  <Skeleton className="h-[26px] w-[34px] rounded-none" />
                  <div className="grid gap-1.5">
                    <Skeleton className="h-3 w-28" />
                    <Skeleton className="h-2.5 w-20" />
                  </div>
                </div>
                <Skeleton className="h-3 w-12" />
              </div>
              <Skeleton className="m-3 h-5 w-[calc(100%-1.5rem)] max-w-[29rem]" />
            </div>
          </div>
          <section className="mg-home-pulse">
            <div className="mg-home-pulse-head">
              <div className="grid gap-2">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-8 w-64 max-w-full" />
              </div>
              <Skeleton className="h-3 w-28" />
            </div>
            <div className="mg-home-pulse-composition grid gap-[var(--mg-space-lg)]">
              <Skeleton className="h-[54px] w-full rounded-none" />
              <div className="grid grid-cols-3 gap-x-4 gap-y-3">
                {READING_LINES.map((key) => (
                  <Skeleton key={key} className="h-4 w-full rounded-none" />
                ))}
              </div>
            </div>
            <div className="mt-8 hidden grid-cols-4 gap-px sm:grid">
              {DIRECTORY_FACT_SKELETONS.map((key) => (
                <Skeleton key={key} className="h-24 w-full rounded-none" />
              ))}
            </div>
            <div className="mg-home-pulse-foot">
              <Skeleton className="h-3 w-44" />
              <Skeleton className="h-3 w-32" />
            </div>
          </section>
        </div>
        <div className="grid min-h-12 grid-cols-3 gap-px border-t border-rule px-[var(--mg-section-x)] py-3">
          {FACT_SKELETONS.map((key) => (
            <Skeleton key={key} className="h-5 w-28 max-w-full" />
          ))}
        </div>
      </header>
    </PendingDocument>
  );
}

function DirectoryLoadingSkeleton({ label }: { label: string }) {
  return (
    <PendingDocument label={label}>
      <LoadingHero variant="directory" facts={DIRECTORY_FACT_SKELETONS} />
      <div className="mg-section mg-directory-section mg-directory-section--table-first">
        <LoadingTableView />
      </div>
    </PendingDocument>
  );
}

function EntityLoadingSkeleton({
  label,
  table = DEFAULT_TABLE,
  block = false,
}: {
  label: string;
  table?: LoadingTable;
  block?: boolean;
}) {
  return (
    <PendingDocument label={label}>
      <LoadingHero variant="entity" block={block} />
      <div className="mg-section">
        <LoadingTableView table={table} />
      </div>
    </PendingDocument>
  );
}

function LoadingAnalysisSection({ compact = false }: { compact?: boolean }) {
  return (
    <section className="mg-section">
      <div className="mg-section-head">
        <div className="grid gap-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-72 max-w-full" />
        </div>
        <Skeleton className="h-8 w-36" />
      </div>
      <div className="mg-section-visual grid gap-3">
        <Skeleton className={`${compact ? "h-32" : "h-64"} w-full rounded-none`} />
        <div className="grid grid-cols-3 gap-px">
          {FACT_SKELETONS.map((key) => (
            <Skeleton key={key} className="h-12 w-full rounded-none" />
          ))}
        </div>
      </div>
    </section>
  );
}

function OperationalLoadingSkeleton({ label }: { label: string }) {
  return (
    <PendingDocument label={label}>
      <LoadingHero variant="operational" facts={OPERATIONAL_FACT_SKELETONS} />
      <LoadingAnalysisSection />
      <LoadingAnalysisSection compact />
    </PendingDocument>
  );
}

function CompareLoadingSkeleton({ label }: { label: string }) {
  return (
    <PendingDocument label={label}>
      <LoadingHero variant="compare" />
      <section className="mg-section mg-compare-ledger-section">
        <div className="mg-section-head">
          <div className="grid gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-64 max-w-full" />
          </div>
        </div>
        <div className="mg-compare overflow-hidden border-y border-rule">
          <div className="grid min-w-[42rem] grid-cols-[12rem_repeat(3,minmax(10rem,1fr))] gap-px">
            {[...READING_LINES, "seventh", "eighth"].map((key, index) => (
              <Skeleton
                key={key}
                className={`${index < 4 ? "h-20" : "h-14"} w-full rounded-none`}
              />
            ))}
          </div>
        </div>
      </section>
    </PendingDocument>
  );
}

function SettingsLoadingSkeleton({ label }: { label: string }) {
  return (
    <PendingDocument label={label}>
      <LoadingHero variant="settings" />
      <section className="mg-section mg-settings-preferences">
        <div className="mg-section-head">
          <div className="grid gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-64 max-w-full" />
          </div>
        </div>
        <div className="mg-section-visual grid gap-3">
          {FACT_SKELETONS.map((key) => (
            <Skeleton key={key} className="h-11 w-full max-w-[40rem] rounded-none" />
          ))}
        </div>
      </section>
    </PendingDocument>
  );
}

function ReadingLoadingSkeleton({ label }: { label: string }) {
  return (
    <PendingDocument label={label}>
      <div className="mx-auto grid w-full max-w-4xl gap-[var(--mg-space-xl)] px-[var(--mg-section-x)] py-[var(--mg-space-xl)] sm:py-[var(--mg-space-2xl)]">
        <div className="grid gap-4 border-b border-rule pb-8">
          <Skeleton className="h-10 w-2/3 max-w-xl" />
          <Skeleton className="h-5 w-full max-w-2xl" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="grid max-w-[68ch] gap-4">
          {READING_LINES.map((key, index) => (
            <Skeleton
              key={key}
              className={`${index === 0 ? "h-7 w-2/5" : index % 3 === 0 ? "h-4 w-4/5" : "h-4 w-full"}`}
            />
          ))}
        </div>
      </div>
    </PendingDocument>
  );
}

/**
 * A truthful first-paint shape for every route family. Decorative placeholders
 * are hidden from assistive technology; the outer document owns the one polite
 * busy announcement.
 */
export function DocumentLoadingSkeleton({
  label = "Loading page data",
  archetype = "entity",
}: {
  label?: string;
  archetype?: RouteLoadingArchetype;
}) {
  switch (archetype) {
    case "landing":
      return <LandingLoadingSkeleton label={label} />;
    case "directory":
      return <DirectoryLoadingSkeleton label={label} />;
    case "operational":
      return <OperationalLoadingSkeleton label={label} />;
    case "compare":
      return <CompareLoadingSkeleton label={label} />;
    case "settings":
      return <SettingsLoadingSkeleton label={label} />;
    case "reading":
      return <ReadingLoadingSkeleton label={label} />;
    case "block":
      return <EntityLoadingSkeleton label={label} table={BLOCK_TABLE} block />;
    case "entity":
    default:
      return <EntityLoadingSkeleton label={label} />;
  }
}

/** The router fallback includes the real shell so a slow navigation keeps its navigation context. */
export function RouteLoadingSkeleton({
  label,
  archetype,
}: {
  label?: string;
  archetype?: RouteLoadingArchetype;
}) {
  return (
    <AppShell chromeOnly>
      <DocumentLoadingSkeleton label={label} archetype={archetype} />
    </AppShell>
  );
}

export function DirectoryRouteLoadingSkeleton() {
  return <RouteLoadingSkeleton label="Loading directory" archetype="directory" />;
}

export function EntityRouteLoadingSkeleton() {
  return <RouteLoadingSkeleton label="Loading detail" archetype="entity" />;
}

/** The block route's pending state uses its real primary-ledger geometry, not a generic panel. */
export function BlockDetailLoadingSkeleton() {
  return <RouteLoadingSkeleton label="Loading block detail" archetype="block" />;
}
