import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import {
  PageHero,
  ShareButton,
  DownloadCsvButton,
  ActionBar,
  DensityToggle,
  type Density,
} from "@jsonbored/ui-kit";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, StaleBanner, Skeleton } from "@/components/metagraphed/states";
import { API_BASE } from "@/lib/metagraphed/config";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { validatorsQuery } from "@/lib/metagraphed/queries";
import { buildUrl } from "@/lib/metagraphed/client";
import { formatNumber, isStaleFreshness, classNames } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { ValidatorSubnetHeatmap } from "@/components/metagraphed/charts/validator-subnet-heatmap";
import { ValidatorDominanceChart } from "@/components/metagraphed/charts/validator-dominance-chart";
import { taoCompact, SponsoredBadge } from "@/components/metagraphed/neuron-format";
import { ValidatorCardList } from "@/components/metagraphed/validator-card-list";
import { ValidatorGuide } from "@/components/metagraphed/validator-guide";
import { VALIDATOR_COLUMNS } from "@/components/metagraphed/validator-columns";
import {
  ValidatorsCompareDrawer,
  ValidatorCompareToggle,
} from "@/components/metagraphed/validators-compare-drawer";
import { SortHeader, ariaSort } from "@/components/metagraphed/table-controls";
import type { GlobalValidatorSort } from "@/lib/metagraphed/types";

// The full GlobalValidatorSort set the /api/v1/validators endpoint accepts.
// Stake / emission / dominance / trust get their own columns in #3359; this
// baseline page only renders hotkey identity + subnet/UID counts (#3360 adds the
// dedicated active-subnet column), but every sort key stays selectable.
const validatorSortKeys = [
  "subnet_count",
  "uid_count",
  "stake_dominance",
  "total_stake",
  "total_emission",
  "avg_validator_trust",
  "max_validator_trust",
] as const;

const SORT_LABELS: Record<GlobalValidatorSort, string> = {
  subnet_count: "Active subnets",
  uid_count: "UIDs",
  stake_dominance: "Dominance",
  total_stake: "Total stake",
  total_emission: "Total emission",
  avg_validator_trust: "Avg trust",
  max_validator_trust: "Max trust",
};

const validatorsSearchSchema = z.object({
  sort: fallback(z.enum(validatorSortKeys), "subnet_count").default("subnet_count"),
  // #5344: bring Validators up to the canonical ranked-list interaction model
  // (Subnets) — a sort DIRECTION toggled by clicking a column header, and a row
  // density control — instead of a bare, single-direction <select>.
  order: fallback(z.enum(["asc", "desc"]), "desc").default("desc"),
  density: fallback(z.enum(["compact", "comfortable"]), "comfortable").default("comfortable"),
});

export const Route = createFileRoute("/validators/")({
  validateSearch: zodValidator(validatorsSearchSchema),
  head: () => ({
    meta: [
      { title: "Validators — Metagraphed" },
      {
        name: "description",
        content:
          "Network-wide Bittensor validator directory — hotkeys ranked across subnets, with active-subnet and UID counts, computed live from the chain-direct metagraph.",
      },
      { property: "og:title", content: "Validators — Metagraphed" },
      {
        property: "og:description",
        content: "Network-wide Bittensor validator directory across all subnets.",
      },
    ],
  }),
  component: ValidatorsPage,
});

function ValidatorsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const sort = search.sort ?? "subnet_count";
  const order = search.order ?? "desc";
  const density = search.density ?? "comfortable";
  // Mirror the sibling ranked-list pages (subnets/blocks/surfaces): export the
  // current view as CSV. DownloadCsvButton appends `format=csv`; the backend's
  // handleGlobalValidators already serves it (#5482).
  const validatorsCsvUrl = buildUrl("/api/v1/validators", { sort });
  // Clicking a column header sorts by it; clicking the active one flips
  // direction. Metrics default to descending (highest first) — matching the
  // endpoint's own default order — so the first click on a new column shows the
  // most-ranked rows, and the toggle reveals the tail.
  const onSort = (field: string) =>
    navigate({
      search: (prev: Record<string, unknown>) =>
        ({
          ...prev,
          sort: field,
          order: prev.sort === field && prev.order === "desc" ? "asc" : "desc",
        }) as never,
      replace: true,
    });
  const onDensityChange = (d: Density) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, density: d }) as never,
      replace: true,
    });
  return (
    <AppShell>
      <PageHero
        eyebrow="Directory"
        live
        title="Validators"
        description="Network-wide validator directory — hotkeys ranked across all Bittensor subnets, computed live from the chain-direct metagraph."
        actions={
          <>
            <ActionBar>
              <DownloadCsvButton url={validatorsCsvUrl} bare />
              <ShareButton bare />
            </ActionBar>
          </>
        }
      />
      <ValidatorGuide />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <ValidatorsTable
            sort={sort}
            order={order}
            density={density}
            onSort={onSort}
            onDensityChange={onDensityChange}
          />
        </Suspense>
      </QueryErrorBoundary>
      <div className="mt-6" id="validator-dominance">
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-48 w-full" />}>
            <ValidatorDominanceChart />
          </Suspense>
        </QueryErrorBoundary>
      </div>
      <div className="mt-6" id="validator-subnet-heatmap">
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <ValidatorSubnetHeatmap />
          </Suspense>
        </QueryErrorBoundary>
      </div>
      <ApiSourceFooter paths={["/api/v1/validators"]} />
      {/* #6998: floating compare dock — self-hides when nothing is selected. */}
      <ValidatorsCompareDrawer />
    </AppShell>
  );
}

function ValidatorsTable({
  sort,
  order,
  density,
  onSort,
  onDensityChange,
}: {
  sort: GlobalValidatorSort;
  order: "asc" | "desc";
  density: Density;
  onSort: (field: string) => void;
  onDensityChange: (d: Density) => void;
}) {
  const res = useSuspenseQuery(validatorsQuery({ sort })).data;
  const serverRanked = res.data.validators;
  const generatedAt = res.meta?.generated_at ?? null;
  // The endpoint ranks descending by `sort`, so ascending is that list reversed.
  const validators = order === "asc" ? [...serverRanked].reverse() : serverRanked;
  const compact = density === "compact";

  return (
    <div className="space-y-3">
      {isStaleFreshness(generatedAt) ? (
        <StaleBanner
          generatedAt={generatedAt}
          refreshQueryKeys={[validatorsQuery({ sort }).queryKey]}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-ink-muted">
          {formatNumber(validators.length)} validators · ranked by {SORT_LABELS[sort]}
        </span>
        <DensityToggle value={density} onChange={onDensityChange} />
      </div>

      {validators.length > 0 ? (
        <div className="hidden md:block overflow-x-auto rounded-lg border border-border">
          <table
            className={classNames(
              "w-full text-left text-sm",
              compact && "[&_td]:!py-1 [&_th]:!py-1",
            )}
          >
            <thead className="bg-surface/50">
              <tr>
                <th className="w-8 px-3 py-2">
                  <span className="sr-only">Add to compare</span>
                </th>
                {VALIDATOR_COLUMNS.map((col) => (
                  <th
                    key={col.header}
                    className={col.thClassName}
                    aria-sort={col.sortKey ? ariaSort(sort === col.sortKey, order) : undefined}
                  >
                    {col.sortKey ? (
                      <SortHeader
                        label={col.header}
                        field={col.sortKey}
                        active={sort === col.sortKey}
                        order={order}
                        onSort={onSort}
                        align={col.thClassName.includes("text-right") ? "right" : "left"}
                      />
                    ) : (
                      col.header
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {validators.map((v) => (
                <tr key={v.hotkey} className="hover:bg-surface/40">
                  <td className="px-3 py-2 align-middle">
                    <ValidatorCompareToggle hotkey={v.hotkey} />
                  </td>
                  {VALIDATOR_COLUMNS.map((col) => (
                    <td key={col.header} className={col.tdClassName}>
                      {col.cell(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No validators indexed yet"
          description="The global validator directory is empty for this window."
          action={{
            label: "Open /api/v1/validators",
            href: `${API_BASE}/api/v1/validators`,
            external: true,
          }}
        />
      )}

      {validators.length > 0 ? (
        <ValidatorCardList
          validators={validators}
          className="grid gap-3 sm:grid-cols-2 md:hidden"
        />
      ) : null}
    </div>
  );
}
