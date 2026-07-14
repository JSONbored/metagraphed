import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import { PageHero, ShareButton } from "@jsonbored/ui-kit";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, StaleBanner, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { validatorsQuery } from "@/lib/metagraphed/queries";
import { formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { ValidatorSubnetHeatmap } from "@/components/metagraphed/charts/validator-subnet-heatmap";
import { taoCompact, FeaturedBadge } from "@/components/metagraphed/neuron-table";
import { ValidatorGuide } from "@/components/metagraphed/validator-guide";
import { ValidatorIdentityChip } from "@/components/metagraphed/validator-identity-chip";
import {
  annualizedDelegatorApyPct,
  formatApyPct,
  formatTakePct,
} from "@/lib/metagraphed/validator-apy";
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
  return (
    <AppShell>
      <PageHero
        eyebrow="Directory"
        live
        title="Validators"
        description="Network-wide validator directory — hotkeys ranked across all Bittensor subnets, computed live from the chain-direct metagraph."
        actions={<ShareButton />}
      />
      <ValidatorGuide />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <ValidatorsTable
            sort={sort}
            onSortChange={(v) =>
              navigate({
                search: (prev: Record<string, unknown>) => ({ ...prev, sort: v }) as never,
                replace: true,
              })
            }
          />
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

const TH = "px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted";

function SortSelect({
  value,
  onChange,
}: {
  value: GlobalValidatorSort;
  onChange: (v: GlobalValidatorSort) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 rounded border border-border bg-paper px-2 py-1 text-xs">
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">Sort</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as GlobalValidatorSort)}
        className="bg-transparent text-ink-strong text-xs rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Sort validators"
      >
        {validatorSortKeys.map((k) => (
          <option key={k} value={k}>
            {SORT_LABELS[k]}
          </option>
        ))}
      </select>
    </label>
  );
}

function ValidatorsTable({
  sort,
  onSortChange,
}: {
  sort: GlobalValidatorSort;
  onSortChange: (v: GlobalValidatorSort) => void;
}) {
  const res = useSuspenseQuery(validatorsQuery({ sort })).data;
  const validators = res.data.validators;
  const generatedAt = res.meta?.generated_at ?? null;

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
        <SortSelect value={sort} onChange={onSortChange} />
      </div>

      {validators.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface/50">
              <tr>
                <th className={TH}>Operator</th>
                <th className={TH}>Hotkey</th>
                <th className={TH}>Coldkey</th>
                <th className={`${TH} text-right`}>Take</th>
                <th className={`${TH} text-right`}>Est. APY</th>
                <th className={`${TH} text-right`}>Active subnets</th>
                <th className={`${TH} text-right`}>UIDs</th>
                <th className={`${TH} text-right`}>Nominators</th>
                <th className={`${TH} text-right`}>Dominance</th>
                <th className={`${TH} text-right`}>Total stake</th>
                <th className={`${TH} text-right`}>Total emission</th>
                <th className={`${TH} text-right`}>Est. APY</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {validators.map((v) => (
                <tr key={v.hotkey} className="hover:bg-surface/40">
                  <td className="px-3 py-2 font-mono text-[11px]">
                    <div className="flex items-center gap-1.5">
                      {v.featured ? <FeaturedBadge /> : null}
                      <Link
                        to="/validators/$hotkey"
                        params={{ hotkey: v.hotkey }}
                        className="text-ink-strong hover:text-accent hover:underline"
                        title={v.hotkey}
                      >
                        {shortHash(v.hotkey) ?? v.hotkey}
                      </Link>
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
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
                  <td className="px-3 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                    {formatNumber(v.subnet_count)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {formatNumber(v.uid_count)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {v.nominator_count != null ? formatNumber(v.nominator_count) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                    {v.stake_dominance != null ? `${(v.stake_dominance * 100).toFixed(2)}%` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                    {taoCompact(v.total_stake_tao)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {taoCompact(v.total_emission_tao)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                    {v.apy_estimate != null ? `${(v.apy_estimate * 100).toFixed(1)}%` : "—"}
                  </td>
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
    </div>
  );
}
