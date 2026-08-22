import { useQuery } from "@tanstack/react-query";
import {
  subnetOwnerCutQuery,
  subnetRevenueQuery,
  subnetWalletsQuery,
} from "@/lib/metagraphed/queries";
import { Chip, ExternalLink, FactStrip, FactCell } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, ErrorState } from "@/components/metagraphed/states";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import {
  DISPOSITION_BUCKETS,
  alphaLabel,
  bucketLabel,
  bucketLabelValue,
  bucketTone,
  evidenceNote,
  finite,
  summariseDisposition,
  taoLabel,
  walletRows,
  type WalletRowModel,
} from "@/lib/metagraphed/money-map-model";
import { usdLabel } from "@/lib/metagraphed/revenue-panel-model";
import { formatTao } from "@/lib/metagraphed/format";

/**
 * #10511: one panel answering what comes in, what is emitted, who gets it, and
 * where it goes.
 *
 * `unresolved` RENDERS PLAINLY. It is the majority state today — every subnet's
 * disposition is unresolved, because the flow streams are not wired in — and
 * styling it as a warning would turn a gap in OUR coverage into an accusation
 * across most of the network.
 *
 * Chain-derived and declared are visually distinct, and every attributed address
 * shows its evidence inline. An attribution repeated without its proof is an
 * unsourced allegation made on our behalf to someone who cannot check it.
 */

function WalletRow({ row }: { row: WalletRowModel }) {
  const note = evidenceNote(row);
  return (
    <li className="flex flex-wrap items-center gap-2 rounded border border-border/80 px-3 py-2">
      {/* Chain-derived vs declared, distinguishable without reading the label:
          the chain read is an accent chip, a human attribution is muted. */}
      <Chip tone={row.chainDerived ? "accent" : "muted"}>{row.role}</Chip>
      <AddressDisplay
        ss58={row.ss58}
        fallback={<span className="text-ink-muted">—</span>}
        identityName={row.name ?? undefined}
        preload="intent"
      />
      {row.unspendableProofBasis ? (
        <span className="text-13 text-ink-muted">unspendable: {row.unspendableProofBasis}</span>
      ) : null}
      {/* ExternalLink, not a bare anchor: it applies safeExternalUrl filtering
          to a URL that came from a registry file somebody else wrote. */}
      {row.sourceUrls.map((url) => (
        <ExternalLink key={url} href={url} className="text-13 text-accent">
          evidence
        </ExternalLink>
      ))}
      {note ? <span className="text-13 text-ink-muted">{note}</span> : null}
    </li>
  );
}

export function SubnetMoneyMapPanel({ netuid }: { netuid: number }) {
  const walletsQ = useQuery(subnetWalletsQuery(netuid));
  const ownerCutQ = useQuery(subnetOwnerCutQuery(netuid));
  const revenueQ = useQuery(subnetRevenueQuery(netuid));

  if (walletsQ.isError) {
    return (
      <ErrorState
        error={walletsQ.error}
        onRetry={() => walletsQ.refetch()}
        context="subnet money map"
      />
    );
  }
  if (walletsQ.isLoading || ownerCutQ.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  const wallets = walletRows(walletsQ.data?.data?.wallets);
  const ownerCut = (ownerCutQ.data?.data ?? {}) as Record<string, unknown>;
  const accrual = (ownerCut.accrual ?? {}) as Record<string, unknown>;
  const disposition = (ownerCut.disposition ?? {}) as Record<string, unknown>;
  const buckets = (disposition.buckets ?? {}) as Record<string, unknown>;
  const summary = summariseDisposition(disposition);
  const revenue = ((revenueQ.data?.data ?? {}) as Record<string, unknown>).revenue as
    Record<string, unknown> | undefined;
  const emission = (revenue?.emission ?? {}) as Record<string, unknown>;

  return (
    <div className="space-y-4">
      <FactStrip>
        <FactCell
          label="Emission in"
          value={formatTao(finite(emission.tao))}
          hint="TAO the network emits to this subnet"
        />
        <FactCell
          label="Owner cut accrued"
          value={alphaLabel(accrual.alpha)}
          hint={
            finite(accrual.owner_cut) == null
              ? "Share not read — never assumed at 18%"
              : `${((finite(accrual.owner_cut) ?? 0) * 100).toFixed(2)}% of alpha emission`
          }
        />
        <FactCell
          label="Owner cut, priced"
          value={taoLabel(accrual.tao)}
          hint={usdLabel(accrual.usd) ?? "TAO/USD not read"}
        />
        <FactCell
          label="Revenue in"
          value={usdLabel(revenue?.revenue_usd) ?? "Not observed"}
          hint="External revenue, if published"
        />
      </FactStrip>

      <div className="space-y-2">
        <div className="text-13 text-ink-muted">Where the owner cut went</div>
        <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-5">
          {DISPOSITION_BUCKETS.map((bucket) => (
            <div key={bucket} className="rounded border border-border/80 px-3 py-2">
              <div className="text-13 text-ink-muted">
                <Chip tone={bucketTone()}>{bucketLabel(bucket)}</Chip>
              </div>
              <div className="mt-1 font-display text-13 font-semibold tabular-nums text-ink-strong">
                {bucketLabelValue(buckets[bucket])}
              </div>
            </div>
          ))}
        </div>
        <Panel bodyClassName="text-13 text-ink-muted">{summary.note}</Panel>
        {/* Reported, never balanced away. A negative residual means the parts
            exceed the whole and is shown as such. */}
        {finite(disposition.residual_alpha) != null ? (
          <div className="text-13 text-ink-muted">
            Residual: {alphaLabel(disposition.residual_alpha)} · reconciles:{" "}
            {disposition.reconciles === true ? "yes" : "no"}
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="text-13 text-ink-muted">Declared wallets ({wallets.length})</div>
        {wallets.length === 0 ? (
          <Panel bodyClassName="text-13 text-ink-muted">
            Nothing has been attributed for this subnet. That is a statement about what has been
            disclosed and evidenced, not about what exists.
          </Panel>
        ) : (
          <ul className="space-y-1">
            {wallets.map((row) => (
              <WalletRow key={`${row.role}:${row.ss58}`} row={row} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
