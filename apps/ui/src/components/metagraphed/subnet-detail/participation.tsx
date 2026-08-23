import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, FactStrip, RankedRails, type FactCells } from "@jsonbored/ui-kit";
import {
  subnetCostToParticipateQuery,
  subnetDeregistrationsQuery,
  subnetRegistrationsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
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
}: {
  netuid: number;
  economics: SubnetEconomics | null;
}) {
  const cost = useQuery({ ...subnetCostToParticipateQuery(netuid), retry: 0 });
  const registrations = useQuery({ ...subnetRegistrationsQuery(netuid, "30d"), retry: 0 });
  const deregistrations = useQuery({ ...subnetDeregistrationsQuery(netuid, "30d"), retry: 0 });

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
    },
    {
      label: "Permit floor",
      value:
        entry?.validator_permit_floor_tao != null
          ? formatTao(entry.validator_permit_floor_tao)
          : "—",
    },
    {
      label: "Earning floor",
      value:
        entry?.validator_earning_floor_tao != null
          ? formatTao(entry.validator_earning_floor_tao)
          : "—",
    },
    {
      label: "Slots",
      value: maxUids != null ? `${formatNumber(used)} / ${formatNumber(maxUids)}` : "—",
    },
    {
      label: "Registrations 30d",
      value: formatNumber(registrations.data?.data.registrations ?? null),
    },
    {
      label: "Miners earning nothing",
      value:
        typeof zeroPct === "number"
          ? `${(zeroPct * 100).toFixed(0)}%`
          : formatNumber(deregistrations.data?.data.deregistrations ?? null),
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

  return (
    <AnalyticsSection
      id="participation"
      name="Participation"
      question="What it costs to register and what a slot earns."
      visual={<FactStrip cells={cells} variant="grid" />}
      legend={
        churn.length > 0 ? (
          <RankedRails
            items={churn}
            formatValue={(v) => formatNumber(v)}
            columns={{ value: "Count", name: "Slot movement", track: "Share of movement" }}
            ariaLabel={`Subnet ${netuid} slot movement over 30 days`}
            source={`sn-${netuid}-churn`}
          />
        ) : null
      }
      footnote="30d · a declared minimum is the floor to run, not the spec to earn"
    />
  );
}
