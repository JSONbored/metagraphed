import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, FactStrip, RankedRails, type FactCells } from "@jsonbored/ui-kit";
import {
  subnetCostToParticipateQuery,
  subnetDeregistrationsQuery,
  subnetRegistrationsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber, formatPct, formatTao } from "@/lib/metagraphed/format";
import { useHydrated } from "@/hooks/use-hydrated";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { ErrorState } from "@/components/metagraphed/states";
import type { SubnetEconomics } from "@/lib/metagraphed/types";

/**
 * Section 6 — what a slot costs and what it earns.
 *
 * The three floors come first because they are the decision: a registration
 * burn you can afford on a subnet whose earning floor you cannot reach is
 * not an opportunity. The churn rail is the second question -- how contested
 * those slots are -- and it is deliberately below the numbers.
 */
export function ParticipationSection({
  netuid,
  economics,
  economicsPending = false,
}: {
  netuid: number;
  economics: SubnetEconomics | null;
  economicsPending?: boolean;
}) {
  const { ref, nearViewport } = useNearViewport();
  const cost = useQuery({
    ...subnetCostToParticipateQuery(netuid),
    enabled: nearViewport,
    retry: 0,
  });
  const registrations = useQuery({
    ...subnetRegistrationsQuery(netuid, "30d"),
    enabled: nearViewport,
    retry: 0,
  });
  const deregistrations = useQuery({
    ...subnetDeregistrationsQuery(netuid, "30d"),
    enabled: nearViewport,
    retry: 0,
  });
  const hydrated = useHydrated();

  const entry = cost.data?.data.entry_cost;
  const earnings = cost.data?.data.earnings;
  const maxUids = typeof economics?.max_uids === "number" ? economics.max_uids : null;
  const used =
    (typeof economics?.miner_count === "number" ? economics.miner_count : 0) +
    (typeof economics?.validator_count === "number" ? economics.validator_count : 0);
  const zeroPct = earnings?.zero_emission_pct;

  const cells: FactCells = [
    {
      label: "Registration cost",
      value: entry?.registration_cost_tao != null ? formatTao(entry.registration_cost_tao) : "—",
      loading: cost.isPending,
    },
    {
      label: "Permit floor",
      value:
        entry?.validator_permit_floor_tao != null
          ? formatTao(entry.validator_permit_floor_tao)
          : "—",
      loading: cost.isPending,
    },
    {
      label: "Earning floor",
      value:
        entry?.validator_earning_floor_tao != null
          ? formatTao(entry.validator_earning_floor_tao)
          : "—",
      loading: cost.isPending,
    },
    {
      label: "Slots",
      value: maxUids != null ? `${formatNumber(used)} / ${formatNumber(maxUids)}` : "—",
      loading: economicsPending,
    },
    {
      label: "Registrations 30d",
      value: formatNumber(registrations.data?.data.registrations ?? null),
      loading: registrations.isPending,
    },
    {
      label: "Miners earning nothing",
      value:
        typeof zeroPct === "number"
          ? `${formatPct(zeroPct, 0)}`
          : formatNumber(deregistrations.data?.data.deregistrations ?? null),
      loading: cost.isPending || (typeof zeroPct !== "number" && deregistrations.isPending),
      delta:
        typeof zeroPct === "number" && zeroPct > 0.5
          ? { text: "most", tone: "bad" }
          : typeof zeroPct === "number"
            ? { text: "some", tone: "neutral" }
            : undefined,
    },
  ];

  const churn = [
    {
      key: "registered",
      label: "Registered",
      value: registrations.data?.data.registrations ?? 0,
    },
    {
      key: "distinct",
      label: "Distinct registrants",
      value: registrations.data?.data.distinct_registrants ?? 0,
    },
    {
      key: "deregistered",
      label: "Deregistered",
      value: deregistrations.data?.data.deregistrations ?? 0,
    },
  ].filter((row) => row.value > 0);
  const churnPending = registrations.isPending || deregistrations.isPending;
  const churnLoading = nearViewport && (!hydrated || churnPending);
  const showChurnLoading = nearViewport && hydrated && churnPending;
  const churnUnavailable = registrations.isError || deregistrations.isError;
  const churnError = registrations.error ?? deregistrations.error;

  return (
    <AnalyticsSection
      id="participation"
      name="Participation"
      question="What it costs to register and what a slot earns."
      visualRef={ref}
      visual={
        !nearViewport ? (
          <p className="mg-section-empty">
            Participation evidence loads as this section approaches.
          </p>
        ) : cost.isError ? (
          <ErrorState
            error={cost.error}
            onRetry={() => void cost.refetch()}
            context="subnet participation floors"
          />
        ) : (
          <FactStrip cells={cells} variant="grid" />
        )
      }
      legend={
        showChurnLoading ? (
          <RankedRails
            items={[]}
            formatValue={(v) => formatNumber(v)}
            columns={{ value: "Count", name: "Slot movement", track: "Share of movement" }}
            ariaLabel={`Subnet ${netuid} slot movement over 30 days`}
            source={`sn-${netuid}-churn`}
            loading
            loadingRows={3}
          />
        ) : churnUnavailable ? (
          <ErrorState
            error={churnError}
            onRetry={() => void Promise.all([registrations.refetch(), deregistrations.refetch()])}
            context="30-day registration activity"
          />
        ) : churn.length > 0 ? (
          <RankedRails
            items={churn}
            formatValue={(v) => formatNumber(v)}
            columns={{ value: "Count", name: "Slot movement", track: "Share of movement" }}
            ariaLabel={`Subnet ${netuid} slot movement over 30 days`}
            source={`sn-${netuid}-churn`}
          />
        ) : null
      }
      footnote={
        !nearViewport
          ? "deferred below the fold · avoids participation and churn requests before they are useful"
          : cost.isError
            ? "chain-direct · retry the affected record above"
            : churnLoading
              ? "Loading 30d registration activity · chain-direct"
              : churnUnavailable
                ? "chain-direct · retry the affected record above"
                : "30d · a declared minimum is the floor to run, not the spec to earn"
      }
    />
  );
}
