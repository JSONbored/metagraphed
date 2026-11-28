import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DataTable, SectionHead, type DataTableColumn } from "@jsonbored/ui-kit";
import { subnetCommitmentsQuery, subnetHotkeyCommitmentQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { useHydrated } from "@/hooks/use-hydrated";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { ErrorState } from "@/components/metagraphed/states";
import type { SubnetCommitmentRow } from "@/lib/metagraphed/types";
import { commitmentSummary } from "./subnet-detail-logic";

const PAGE_SIZE = 25;

const blockCell = (value: unknown) => (typeof value === "number" ? `#${formatNumber(value)}` : "—");

const COLUMNS: DataTableColumn<SubnetCommitmentRow>[] = [
  { key: "hotkey", label: "Hotkey", kind: "identifier", value: (row) => row.hotkey },
  {
    key: "block",
    label: "Committed",
    kind: "number",
    value: (row) => row.block,
    format: blockCell,
  },
  {
    key: "published",
    label: "Published",
    kind: "text",
    wrap: true,
    value: (row) => commitmentSummary(row.fields, row.reveals),
  },
  {
    key: "reveals",
    label: "Reveals",
    kind: "number",
    value: (row) => row.reveals.length,
    demote: true,
  },
];

/** One hotkey's earlier commitments, read when its row is opened. */
function CommitmentHistory({ netuid, hotkey }: { netuid: number; hotkey: string }) {
  const { data, isPending, isError, error, refetch } = useQuery({
    ...subnetHotkeyCommitmentQuery(netuid, hotkey),
    retry: 0,
  });
  if (isPending) return <p className="text-11 text-ink-muted">Loading history…</p>;
  if (isError)
    return <ErrorState error={error} onRetry={() => void refetch()} context="commitment history" />;
  const history = data.data.history;
  return (
    <ol className="flex flex-col gap-1 text-11">
      {history.map((state) => (
        <li key={state.valid_from}>
          <span className="text-ink-muted">
            {state.valid_to === null
              ? `since block ${formatNumber(state.valid_from)}`
              : `blocks ${formatNumber(state.valid_from)}–${formatNumber(state.valid_to)}`}
          </span>
          {" · "}
          {commitmentSummary(state.fields, state.reveals, 240)}
        </li>
      ))}
      <li>
        <Link className="mg-section-more" to="/accounts/$ss58" params={{ ss58: hotkey }}>
          Open this hotkey
        </Link>
      </li>
    </ol>
  );
}

/**
 * What the subnet's hotkeys publish on chain (MET-7365): each one's current
 * commitment -- model revisions, endpoints, peer ids, content hashes,
 * timelocked payloads -- most recently committed first, and the timelocks the
 * chain has revealed. A table, because the reading is a lookup: which hotkey
 * said what, and since when.
 *
 * Evidence under Surfaces, not an eighth page question: it is the other half
 * of what a subnet publishes (#11604's page-shape rule, held by
 * tests/e2e/token-inventory.spec.ts). Same shape as the revenue evidence under
 * Value flow, and addressable on its own anchor.
 */
export function CommitmentsEvidence({ netuid }: { netuid: number }) {
  const [page, setPage] = useState(0);
  const { ref, nearViewport } = useNearViewport<HTMLDivElement>();
  useRegisterApiSource(nearViewport ? [`/api/v1/subnets/${netuid}/commitments`] : []);
  const { data, isPending, isError, error, refetch } = useQuery({
    ...subnetCommitmentsQuery(netuid, { limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    enabled: nearViewport,
    retry: 0,
  });
  const hydrated = useHydrated();
  const loading = nearViewport && (!hydrated || isPending);
  const observed = data?.data.observed_block ?? null;
  const total = data?.data.total ?? null;
  const rows = data?.data.rows ?? [];

  return (
    <section id="commitments" className="mg-section-evidence" aria-labelledby="commitments-heading">
      <SectionHead
        id="commitments-heading"
        name="On-chain commitments"
        question="What this subnet's miners and validators publish on chain."
      />
      <div className="mg-section-visual" ref={ref}>
        {/* Nothing server-rendered before the block nears the viewport: the
            page's HTML ratchet (tests/e2e/indexable-routes.spec.ts) has no
            room for a skeleton table the reader may never scroll to, and the
            table mounts with its data the moment they do. */}
        {!nearViewport ? null : isError ? (
          <ErrorState error={error} onRetry={() => void refetch()} context="on-chain commitments" />
        ) : (
          <DataTable
            rows={rows}
            columns={COLUMNS}
            rowKey={(row) => row.hotkey}
            caption={`Subnet ${netuid} commitments`}
            source={`sn-${netuid}-commitments`}
            loading={loading}
            total={total ?? undefined}
            page={page}
            onPage={setPage}
            pageSize={PAGE_SIZE}
            expand={(row) => <CommitmentHistory netuid={netuid} hotkey={row.hotkey} />}
            storageKey="subnet-commitments-columns"
            mobile="cards"
          />
        )}
      </div>
      <p className="mg-section-note">
        {!nearViewport
          ? "on-chain commitments · chain-direct"
          : loading
            ? "Loading on-chain commitments · chain-direct"
            : isError
              ? "chain-direct · retry the affected record above"
              : observed === null
                ? "No capture observed yet · chain-direct"
                : `${formatNumber(total ?? 0)} hotkeys · block ${formatNumber(observed)} · chain-direct`}
      </p>
    </section>
  );
}
