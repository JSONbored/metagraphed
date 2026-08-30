import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  DataTable,
  RankedRails,
  type DataTableColumn,
  type RankedRailItem,
} from "@jsonbored/ui-kit";
import { subnetValidatorsQuery } from "@/lib/metagraphed/queries";
import { RouterLink } from "@/components/metagraphed/router-link";
import { formatNumber, formatPct } from "@/lib/metagraphed/format";
import { useHydrated } from "@/hooks/use-hydrated";
import { ErrorState } from "@/components/metagraphed/states";
import { taoCompact, scoreStr } from "@/components/metagraphed/neuron-format";
import type { MetagraphNeuron } from "@/lib/metagraphed/types";

const pct = (v?: number | null) =>
  typeof v === "number" && Number.isFinite(v) ? `${formatPct(v, 1)}` : "—";

const COLUMNS: DataTableColumn<MetagraphNeuron>[] = [
  { key: "hotkey", label: "Validator", kind: "identifier", value: (row) => row.hotkey ?? "" },
  { key: "uid", label: "UID", kind: "number", value: (row) => row.uid ?? null },
  {
    key: "stake_tao",
    label: "Stake",
    kind: "number",
    value: (row) => row.stake_tao ?? null,
    format: (v) => (typeof v === "number" ? `${taoCompact(v)}τ` : "—"),
  },
  {
    key: "take",
    label: "Take",
    kind: "number",
    value: (row) => row.take ?? null,
    format: (v) => (typeof v === "number" ? pct(v) : "—"),
    definition: "Take",
  },
  {
    key: "emission_tao",
    label: "Emission",
    kind: "number",
    value: (row) => row.emission_tao ?? null,
    format: (v) => (typeof v === "number" ? `${taoCompact(v)} α` : "—"),
  },
  {
    key: "dividends",
    label: "Dividends",
    kind: "number",
    value: (row) => row.dividends ?? null,
    format: (v) => (typeof v === "number" ? scoreStr(v) : "—"),
    demote: true,
  },
  {
    key: "validator_trust",
    label: "Trust",
    kind: "number",
    value: (row) => row.validator_trust ?? null,
    format: (v) => (typeof v === "number" ? scoreStr(v) : "—"),
    definition: "Validator trust",
  },
  {
    key: "validator_permit",
    label: "Permit",
    kind: "status",
    value: (row) => (row.validator_permit ? "yes" : "no"),
    demote: true,
  },
];

/**
 * Section 3 — who validates here, and what they take.
 *
 * The rail is the answer; the table is the evidence, and it stays folded
 * until asked for. Both marks carry the same entity key, so pointing at a
 * rail row lights its table row and the reverse.
 */
export function ValidatorsSection({ netuid }: { netuid: number }) {
  const [expanded, setExpanded] = useState(false);
  const { data, isPending, isError, error, refetch } = useQuery({
    ...subnetValidatorsQuery(netuid),
    retry: 0,
  });
  const hydrated = useHydrated();
  const loading = !hydrated || isPending;
  const showLoading = hydrated && isPending;
  const validators = data?.data.validators ?? [];

  const items: RankedRailItem[] = [...validators]
    .sort((a, b) => (b.stake_tao ?? 0) - (a.stake_tao ?? 0))
    .slice(0, 10)
    .map((v) => ({
      key: v.hotkey ?? String(v.uid),
      label: v.hotkey ? `${v.hotkey.slice(0, 8)}…${v.hotkey.slice(-4)}` : `UID ${v.uid}`,
      value: v.stake_tao ?? 0,
      href: v.hotkey ? `/validators/${v.hotkey}` : undefined,
      detail: [
        { key: "take", label: "Take", value: pct(v.take) },
        { key: "emission", label: "Emission", value: `${taoCompact(v.emission_tao)} α` },
        { key: "trust", label: "Trust", value: scoreStr(v.validator_trust) },
        { key: "uid", label: "UID", value: String(v.uid ?? "—") },
      ],
    }));

  return (
    <AnalyticsSection
      id="validators"
      name="Validators"
      question="Who validates here and what they take."
      visual={
        showLoading ? (
          <RankedRails
            items={[]}
            formatValue={(v) => `${taoCompact(v)}τ`}
            scale="sqrt"
            columns={{ value: "Stake", name: "Validator", track: "Share of validator stake" }}
            ariaLabel={`Subnet ${netuid} validators by stake`}
            source={`sn-${netuid}-validator`}
            loading
            loadingRows={10}
          />
        ) : isError ? (
          <ErrorState
            error={error}
            onRetry={() => void refetch()}
            context="subnet validator records"
          />
        ) : items.length > 0 ? (
          <RankedRails
            items={items}
            formatValue={(v) => `${taoCompact(v)}τ`}
            scale="sqrt"
            columns={{ value: "Stake", name: "Validator", track: "Share of validator stake" }}
            ariaLabel={`Subnet ${netuid} validators by stake`}
            source={`sn-${netuid}-validator`}
          />
        ) : null
      }
      footnote={
        loading ? (
          "Loading validator records · chain-direct"
        ) : isError ? (
          "chain-direct · retry the affected record above"
        ) : validators.length > 10 && !expanded ? (
          <button type="button" className="mg-section-more" onClick={() => setExpanded(true)}>
            Show all {formatNumber(validators.length)} validators
          </button>
        ) : (
          `${formatNumber(validators.length)} with a permit · chain-direct`
        )
      }
    >
      {expanded ? (
        <DataTable
          rows={validators}
          columns={COLUMNS}
          rowKey={(row) => row.hotkey ?? String(row.uid)}
          caption={`Subnet ${netuid} validators`}
          rowHref={(row) => (row.hotkey ? `/validators/${row.hotkey}` : undefined)}
          link={RouterLink}
          source={`sn-${netuid}-validator`}
          loading={isPending}
          pageSize={25}
          storageKey={`subnet-validators-columns`}
          mobile="cards"
        />
      ) : null}
    </AnalyticsSection>
  );
}
