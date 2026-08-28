import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, RankedRails } from "@jsonbored/ui-kit";
import { accountCounterpartiesQuery } from "@/lib/metagraphed/queries";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { ErrorState } from "@/components/metagraphed/states";
import { formatNumber } from "@/lib/metagraphed/format";
import { counterpartyRail, fmtCompactTao } from "./account-detail-logic";

/**
 * Section 3 — who this account transacts with.
 *
 * This section stands where the issue drafted "History. Balance and stake
 * over time." That producer is empty: `/accounts/{ss58}/history` answers
 * `day_count: 0` for every account probed -- the fixture account, a whale,
 * and an active validator coldkey -- and `/accounts/{ss58}/subnets` answers
 * `subnet_count: 0` while `/positions` returns 61 live positions for the same
 * address. A section that can only ever say "no data" is worse than a
 * section that answers a real question, and counterparties is the question
 * the transfer data can actually answer.
 *
 * Ranked by GROSS movement, not net: an address that sent 1,000 τ and got
 * 1,000 τ back nets to zero and is this account's most significant partner.
 */
export function CounterpartiesSection({ ss58 }: { ss58: string }) {
  const { ref, nearViewport } = useNearViewport("320px 0px");
  const query = useQuery({
    ...accountCounterpartiesQuery(ss58),
    enabled: nearViewport,
    retry: 0,
  });
  const { data, isPending, isError } = query;
  const summary = data?.data;
  const rows = counterpartyRail(summary?.counterparties ?? []);
  const unavailable = isError && !data;

  return (
    <AnalyticsSection
      id="counterparties"
      name="Counterparties"
      question="Who this account transacts with."
      visualRef={ref}
      visual={
        !nearViewport ? (
          <p className="mg-section-empty">
            Counterparty evidence loads as this section approaches.
          </p>
        ) : isPending ? (
          <RankedRails
            items={[]}
            formatValue={fmtCompactTao}
            scale="sqrt"
            columns={{ value: "Moved", name: "Address", track: "Share of transfer volume" }}
            ariaLabel="Transfer counterparties by volume moved"
            source="account-counterparty"
            loading
            loadingRows={6}
          />
        ) : unavailable ? (
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            context="transfer counterparties"
          />
        ) : rows.length > 0 ? (
          <RankedRails
            items={rows}
            formatValue={(value) => fmtCompactTao(value)}
            scale="sqrt"
            columns={{ value: "Moved", name: "Address", track: "Share of transfer volume" }}
            ariaLabel="Transfer counterparties by volume moved"
            source="account-counterparty"
          />
        ) : null
      }
      empty={
        !nearViewport || isPending || unavailable
          ? false
          : "No transfers recorded for this account."
      }
      footnote={
        !nearViewport
          ? "deferred below the fold · counterparty data starts only as this section approaches"
          : isPending
            ? "Loading transfer counterparties"
            : unavailable
              ? "Counterparties unavailable · chain-direct"
              : summary?.scan_capped
                ? `${formatNumber(summary.counterparty_count)} partners across the ${formatNumber(
                    summary.transfers_scanned ?? 0,
                  )} transfers scanned — the scan hit its ceiling, so this is a floor, not a total`
                : rows.length > 0
                  ? `${formatNumber(summary?.counterparty_count ?? 0)} partners · ${formatNumber(
                      summary?.transfers_scanned ?? 0,
                    )} transfers · chain-direct`
                  : "No transfers recorded for this account"
      }
    />
  );
}
