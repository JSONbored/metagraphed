import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useMemo } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import { DensityToggle, PageHero, ShareButton, type Density } from "@jsonbored/ui-kit";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, StaleBanner, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { ariaSort, SortHeader } from "@/components/metagraphed/table-controls";
import { ValidatorsSavedViews } from "@/components/metagraphed/validators-saved-views";
import {
  VALIDATOR_COLUMNS,
  validatorTableMono,
  validatorTablePad,
} from "@/components/metagraphed/validator-columns";
import { validatorsQuery } from "@/lib/metagraphed/queries";
import { classNames, formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";
import { ValidatorSubnetHeatmap } from "@/components/metagraphed/charts/validator-subnet-heatmap";
import { ValidatorCardList } from "@/components/metagraphed/validator-card-list";
import { ValidatorGuide } from "@/components/metagraphed/validator-guide";
import { useIsMobile } from "@/hooks/use-mobile";
import type { GlobalValidator, GlobalValidatorSort } from "@/lib/metagraphed/types";

// The full GlobalValidatorSort set the /api/v1/validators endpoint accepts.
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

/** Numeric value for the active GlobalValidatorSort key (API field names differ slightly). */
function validatorSortValue(v: GlobalValidator, sort: GlobalValidatorSort): number | null {
  switch (sort) {
    case "subnet_count":
      return v.subnet_count;
    case "uid_count":
      return v.uid_count;
    case "stake_dominance":
      return v.stake_dominance;
    case "total_stake":
      return v.total_stake_tao;
    case "total_emission":
      return v.total_emission_tao;
    case "avg_validator_trust":
      return v.avg_validator_trust;
    case "max_validator_trust":
      return v.max_validator_trust;
  }
}

/**
 * Client-side order for the URL `order` param. The validators API always ranks
 * descending for the selected sort key; we re-sort the returned page so ascending
 * is a true field sort (nulls last, hotkey tie-break) rather than a list reverse.
 */
function compareValidators(
  a: GlobalValidator,
  b: GlobalValidator,
  sort: GlobalValidatorSort,
  order: "asc" | "desc",
): number {
  const av = validatorSortValue(a, sort);
  const bv = validatorSortValue(b, sort);
  if (av == null && bv == null) return a.hotkey.localeCompare(b.hotkey);
  if (av == null) return 1;
  if (bv == null) return -1;
  if (av !== bv) {
    const cmp = av < bv ? -1 : 1;
    return order === "asc" ? cmp : -cmp;
  }
  return a.hotkey.localeCompare(b.hotkey);
}

const validatorsSearchSchema = z.object({
  sort: fallback(z.enum(validatorSortKeys), "subnet_count").default("subnet_count"),
  // API ranks desc; URL `order` re-sorts the returned page client-side (#5344).
  order: fallback(z.enum(["asc", "desc"]), "desc").default("desc"),
  density: fallback(z.enum(["comfortable", "compact"]), "comfortable").default("comfortable"),
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
  const isMobile = useIsMobile();
  const sort = (search.sort as GlobalValidatorSort) ?? "subnet_count";
  const order = search.order === "asc" ? "asc" : "desc";
  const effectiveDensity: Density =
    search.density === "compact" || search.density === "comfortable"
      ? search.density
      : isMobile
        ? "compact"
        : "comfortable";

  const setDensity = (d: Density) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, density: d }) as never,
      replace: true,
    });

  const onSort = (field: string) => {
    if (!(validatorSortKeys as readonly string[]).includes(field)) return;
    navigate({
      search: (prev: { sort?: string; order?: "asc" | "desc" }) =>
        ({
          ...prev,
          sort: field,
          order: prev.sort === field && prev.order === "desc" ? "asc" : "desc",
        }) as never,
      replace: true,
    });
  };

  return (
    <AppShell>
      <PageHero
        eyebrow="Directory"
        live
        title="Validators"
        description="Network-wide validator directory — hotkeys ranked across all Bittensor subnets, computed live from the chain-direct metagraph."
        actions={
          <>
            <DensityToggle value={effectiveDensity} onChange={setDensity} />
            <ShareButton />
          </>
        }
      />
      <ValidatorGuide />
      <ValidatorsSavedViews />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <ValidatorsTable sort={sort} order={order} density={effectiveDensity} onSort={onSort} />
        </Suspense>
      </QueryErrorBoundary>
      <div className="mt-6" id="validator-subnet-heatmap">
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <ValidatorSubnetHeatmap />
          </Suspense>
        </QueryErrorBoundary>
      </div>
      <ApiSourceFooter paths={["/api/v1/validators"]} />
    </AppShell>
  );
}

function ValidatorsTable({
  sort,
  order,
  density,
  onSort,
}: {
  sort: GlobalValidatorSort;
  order: "asc" | "desc";
  density: Density;
  onSort: (field: string) => void;
}) {
  const res = useSuspenseQuery(validatorsQuery({ sort })).data;
  const generatedAt = res.meta?.generated_at ?? null;
  const validators = useMemo(
    () => [...res.data.validators].sort((a, b) => compareValidators(a, b, sort, order)),
    [res.data.validators, sort, order],
  );

  const pad = validatorTablePad(density);
  const mono = validatorTableMono(density);

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
          {formatNumber(validators.length)} validators · ranked by {SORT_LABELS[sort]} ({order})
        </span>
      </div>

      {validators.length > 0 ? (
        <div className="hidden md:block overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 shadow-[0_1px_0_0_var(--border)]">
              <tr>
                {VALIDATOR_COLUMNS.map((col) => (
                  <th
                    key={col.header}
                    className={classNames(pad, col.thClassName)}
                    aria-sort={col.sortField ? ariaSort(sort === col.sortField, order) : undefined}
                  >
                    {col.sortField ? (
                      <SortHeader
                        label={col.header}
                        field={col.sortField}
                        active={sort === col.sortField}
                        order={order}
                        onSort={onSort}
                        align="right"
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
                <tr key={v.hotkey} className="mg-row-accent hover:bg-surface/40">
                  {VALIDATOR_COLUMNS.map((col) => (
                    <td key={col.header} className={classNames(pad, mono, col.tdClassName)}>
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
