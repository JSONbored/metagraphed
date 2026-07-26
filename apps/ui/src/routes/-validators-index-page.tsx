import { useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/metagraphed/app-shell";
import {
  ShareButton,
  DownloadCsvButton,
  ActionBar,
  DensityToggle,
  type Density,
} from "@jsonbored/ui-kit";
import { AsyncPanel, PageMasthead, TableSkeleton } from "@/components/metagraphed/primitives";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, StaleBanner, Skeleton } from "@/components/metagraphed/states";
import { API_BASE } from "@/lib/metagraphed/config";
import { validatorsQuery } from "@/lib/metagraphed/queries";
import { buildUrl } from "@/lib/metagraphed/client";
import { formatNumber, isStaleFreshness, classNames } from "@/lib/metagraphed/format";
import { ValidatorSubnetHeatmap } from "@/components/metagraphed/charts/validator-subnet-heatmap";
import { ValidatorDominanceChart } from "@/components/metagraphed/charts/validator-dominance-chart";
import { ValidatorCardList } from "@/components/metagraphed/validator-card-list";
import { ValidatorGuide } from "@/components/metagraphed/validator-guide";
import { VALIDATOR_COLUMNS } from "@/components/metagraphed/validator-columns";
import {
  ValidatorsCompareDrawer,
  ValidatorCompareToggle,
} from "@/components/metagraphed/validators-compare-drawer";
import { SortHeader, ariaSort } from "@/components/metagraphed/table-controls";
import type { GlobalValidatorSort } from "@/lib/metagraphed/types";

const SORT_LABELS: Record<GlobalValidatorSort, string> = {
  subnet_count: "Active subnets",
  uid_count: "UIDs",
  stake_dominance: "Dominance",
  total_stake: "Total stake",
  total_emission: "Total emission",
  avg_validator_trust: "Avg trust",
  max_validator_trust: "Max trust",
};

export function ValidatorsPage() {
  const search = useSearch({ from: "/validators/" });
  const navigate = useNavigate({ from: "/validators/" });
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
      <PageMasthead
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
      <AsyncPanel
        context="validators"
        fallback={<TableSkeleton rows={10} columns={6} />}
        retryQueryKeys={[validatorsQuery({ sort }).queryKey]}
      >
        <ValidatorsTable
          sort={sort}
          order={order}
          density={density}
          onSort={onSort}
          onDensityChange={onDensityChange}
        />
      </AsyncPanel>
      <div className="mt-6" id="validator-dominance">
        <AsyncPanel context="validator dominance" fallback={<Skeleton className="h-48 w-full" />}>
          <ValidatorDominanceChart />
        </AsyncPanel>
      </div>
      <div className="mt-6" id="validator-subnet-heatmap">
        <AsyncPanel
          context="validator subnet heatmap"
          fallback={<Skeleton className="h-64 w-full" />}
        >
          <ValidatorSubnetHeatmap />
        </AsyncPanel>
      </div>
      <ApiSourceFooter paths={["/api/v1/validators"]} />
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
        <span className="mg-type-data text-ink-muted">
          {formatNumber(validators.length)} validators · ranked by {SORT_LABELS[sort]}
        </span>
        <DensityToggle value={density} onChange={onDensityChange} />
      </div>

      {validators.length > 0 ? (
        <div className="hidden md:block overflow-x-auto rounded-md border border-border">
          <table
            className={classNames(
              "w-full text-left text-sm",
              compact && "[&_td]:!py-1 [&_th]:!py-1",
            )}
          >
            <thead className="bg-surface/50">
              <tr>
                <th className="w-6 px-3 py-2" aria-label="Compare" />
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
