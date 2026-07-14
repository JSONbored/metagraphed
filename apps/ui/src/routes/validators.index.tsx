import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
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
import { validatorsQuery } from "@/lib/metagraphed/queries";
import { classNames, formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { ValidatorSubnetHeatmap } from "@/components/metagraphed/charts/validator-subnet-heatmap";
import { taoCompact, FeaturedBadge } from "@/components/metagraphed/neuron-table";
import { ValidatorCardList } from "@/components/metagraphed/validator-card-list";
import { ValidatorGuide } from "@/components/metagraphed/validator-guide";
import { ValidatorIdentityChip } from "@/components/metagraphed/validator-identity-chip";
import { formatApyPct, formatTakePct } from "@/lib/metagraphed/validator-apy";
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

  const compact = density === "compact";
  const cellPad = compact ? "px-2 py-1.5" : "px-3 py-2";
  const monoSize = compact ? "text-[10px]" : "text-[11px]";

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
                <th className={cellPad}>Operator</th>
                <th className={cellPad}>Hotkey</th>
                <th className={cellPad}>Coldkey</th>
                <th className={classNames(cellPad, "text-right")}>Take</th>
                <th className={classNames(cellPad, "text-right")}>Est. APY</th>
                <th
                  className={classNames(cellPad, "text-right")}
                  aria-sort={ariaSort(sort === "subnet_count", order)}
                >
                  <SortHeader
                    label="Active subnets"
                    field="subnet_count"
                    active={sort === "subnet_count"}
                    order={order}
                    onSort={onSort}
                    align="right"
                  />
                </th>
                <th
                  className={classNames(cellPad, "text-right")}
                  aria-sort={ariaSort(sort === "uid_count", order)}
                >
                  <SortHeader
                    label="UIDs"
                    field="uid_count"
                    active={sort === "uid_count"}
                    order={order}
                    onSort={onSort}
                    align="right"
                  />
                </th>
                <th className={classNames(cellPad, "text-right")}>Nominators</th>
                <th
                  className={classNames(cellPad, "text-right")}
                  aria-sort={ariaSort(sort === "stake_dominance", order)}
                >
                  <SortHeader
                    label="Dominance"
                    field="stake_dominance"
                    active={sort === "stake_dominance"}
                    order={order}
                    onSort={onSort}
                    align="right"
                  />
                </th>
                <th
                  className={classNames(cellPad, "text-right")}
                  aria-sort={ariaSort(sort === "total_stake", order)}
                >
                  <SortHeader
                    label="Total stake"
                    field="total_stake"
                    active={sort === "total_stake"}
                    order={order}
                    onSort={onSort}
                    align="right"
                  />
                </th>
                <th
                  className={classNames(cellPad, "text-right")}
                  aria-sort={ariaSort(sort === "total_emission", order)}
                >
                  <SortHeader
                    label="Total emission"
                    field="total_emission"
                    active={sort === "total_emission"}
                    order={order}
                    onSort={onSort}
                    align="right"
                  />
                </th>
                <th
                  className={classNames(cellPad, "text-right")}
                  aria-sort={ariaSort(sort === "avg_validator_trust", order)}
                >
                  <SortHeader
                    label="Avg trust"
                    field="avg_validator_trust"
                    active={sort === "avg_validator_trust"}
                    order={order}
                    onSort={onSort}
                    align="right"
                  />
                </th>
                <th
                  className={classNames(cellPad, "text-right")}
                  aria-sort={ariaSort(sort === "max_validator_trust", order)}
                >
                  <SortHeader
                    label="Max trust"
                    field="max_validator_trust"
                    active={sort === "max_validator_trust"}
                    order={order}
                    onSort={onSort}
                    align="right"
                  />
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {validators.map((v) => (
                <ValidatorRow key={v.hotkey} v={v} cellPad={cellPad} monoSize={monoSize} />
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

function ValidatorRow({
  v,
  cellPad,
  monoSize,
}: {
  v: GlobalValidator;
  cellPad: string;
  monoSize: string;
}) {
  const apyPct = v.apy_estimate != null ? v.apy_estimate * 100 : null;
  return (
    <tr className="mg-row-accent hover:bg-surface/40">
      <td className={cellPad}>
        <div className="flex items-center gap-1.5 min-w-0">
          {v.featured ? <FeaturedBadge /> : null}
          <Link
            to="/validators/$hotkey"
            params={{ hotkey: v.hotkey }}
            className="min-w-0 hover:text-accent"
          >
            <ValidatorIdentityChip hotkey={v.hotkey} identity={v.coldkey_identity} size={22} />
          </Link>
        </div>
      </td>
      <td className={classNames(cellPad, "font-mono text-ink-muted", monoSize)}>
        <Link
          to="/validators/$hotkey"
          params={{ hotkey: v.hotkey }}
          className="text-ink-strong hover:text-accent hover:underline"
          title={v.hotkey}
        >
          {shortHash(v.hotkey) ?? v.hotkey}
        </Link>
      </td>
      <td className={classNames(cellPad, "font-mono text-ink-muted", monoSize)}>
        {v.coldkey ? (
          <Link
            to="/accounts/$ss58"
            params={{ ss58: v.coldkey }}
            className="hover:text-accent hover:underline"
            title={v.coldkey}
          >
            {shortHash(v.coldkey) ?? v.coldkey}
          </Link>
        ) : (
          "—"
        )}
      </td>
      <td className={classNames(cellPad, "text-right font-mono tabular-nums text-ink", monoSize)}>
        {formatTakePct(v.take)}
      </td>
      <td className={classNames(cellPad, "text-right font-mono tabular-nums text-ink", monoSize)}>
        {formatApyPct(apyPct)}
      </td>
      <td className={classNames(cellPad, "text-right font-mono tabular-nums text-ink", monoSize)}>
        {formatNumber(v.subnet_count)}
      </td>
      <td
        className={classNames(
          cellPad,
          "text-right font-mono tabular-nums text-ink-muted",
          monoSize,
        )}
      >
        {formatNumber(v.uid_count)}
      </td>
      <td
        className={classNames(
          cellPad,
          "text-right font-mono tabular-nums text-ink-muted",
          monoSize,
        )}
      >
        {v.nominator_count != null ? formatNumber(v.nominator_count) : "—"}
      </td>
      <td className={classNames(cellPad, "text-right font-mono tabular-nums text-ink", monoSize)}>
        {v.stake_dominance != null ? `${(v.stake_dominance * 100).toFixed(2)}%` : "—"}
      </td>
      <td className={classNames(cellPad, "text-right font-mono tabular-nums text-ink", monoSize)}>
        {taoCompact(v.total_stake_tao)}
      </td>
      <td
        className={classNames(
          cellPad,
          "text-right font-mono tabular-nums text-ink-muted",
          monoSize,
        )}
      >
        {taoCompact(v.total_emission_tao)}
      </td>
      <td
        className={classNames(
          cellPad,
          "text-right font-mono tabular-nums text-ink-muted",
          monoSize,
        )}
      >
        {v.avg_validator_trust != null ? v.avg_validator_trust.toFixed(3) : "—"}
      </td>
      <td
        className={classNames(
          cellPad,
          "text-right font-mono tabular-nums text-ink-muted",
          monoSize,
        )}
      >
        {v.max_validator_trust != null ? v.max_validator_trust.toFixed(3) : "—"}
      </td>
    </tr>
  );
}
