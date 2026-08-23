import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, CompositionBreakdown } from "@jsonbored/ui-kit";
import { domainsQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { fmtPct } from "./subnets-index-logic";

/**
 * Section 3 — what the network is building.
 *
 * One bar, because the question is compositional: a domain's meaning is its
 * share of the whole, and a column per domain would make the reader add them
 * up. Each legend row filters the directory rather than navigating away --
 * the taxonomy is a lens on the list, not a separate page (which is what
 * /subnets/category/* was, and why it is gone).
 */
export function DomainsSection({ onPick }: { onPick: (domain: string) => void }) {
  const { data } = useQuery({ ...domainsQuery(), retry: 0 });
  const domains = (data?.data ?? []).filter((row) => (row.subnet_count ?? 0) > 0);

  const segments = domains
    .map((row) => ({
      key: row.domain,
      label: row.domain,
      value: row.total_emission_share ?? 0,
    }))
    .filter((segment) => segment.value > 0)
    .sort((a, b) => b.value - a.value);

  const classified = domains.reduce((acc, row) => acc + (row.subnet_count ?? 0), 0);

  return (
    <AnalyticsSection
      id="domains"
      name="Domains"
      question="What the network is building."
      visual={
        segments.length > 0 ? (
          <CompositionBreakdown
            segments={segments}
            formatValue={(value) => fmtPct(value, 1)}
            legendCols={4}
            ariaLabel="Emission share by capability domain"
            source="subnet-domain"
            onActivate={onPick}
          />
        ) : null
      }
      footnote={`${formatNumber(domains.length)} domains · ${formatNumber(
        classified,
      )} subnets classified · pick one to filter the directory`}
    />
  );
}
