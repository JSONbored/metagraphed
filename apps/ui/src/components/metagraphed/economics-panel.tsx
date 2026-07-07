import { useQuery } from "@tanstack/react-query";
import {
  economicsQuery,
  subnetStakeMovesQuery,
  subnetStakeTransfersQuery,
  subnetTrajectoryQuery,
} from "@/lib/metagraphed/queries";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { MiniStack } from "@/components/metagraphed/charts/stat-with-spark";
import { SparkLegend } from "@/components/metagraphed/charts/spark-legend";
import { Sparkline, type SparklinePoint } from "@/components/metagraphed/charts/sparkline";
import { stakeMovesTileModel } from "@/lib/metagraphed/stake-moves-tile";
import { formatNumber } from "@/lib/metagraphed/format";
import { stakeTransfersTileModel } from "@/lib/metagraphed/stake-transfers-tile";

// #1112: per-subnet on-chain economics (emission share, alpha price, stake,
// validators, volume) from the previously-unused /api/v1/economics. The artifact
// carries all subnets; we fetch once (shared cache) and find this netuid.

function fmtTao(v?: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M τ`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k τ`;
  if (v >= 1) return `${v.toFixed(2)} τ`;
  return `${v.toFixed(4)} τ`;
}

function Notice({ children }: { children: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-xs text-ink-muted">
      {children}
    </div>
  );
}

// #3485: re-delegation (StakeMoved) activity for this subnet over the trailing
// 30-day window, from the already-shipped subnetStakeMovesQuery. The endpoint
// returns a flat window aggregate (count / distinct movers / avg) rather than a
// series, so — per the issue — it renders as a single StatTile using the
// MiniStack + SparkLegend single-snapshot idiom instead of a literal chart. The
// MiniStack splits the total into unique movers vs repeat moves so the lone
// aggregate still reads as a composition.
function StakeMovesTile({ netuid }: { netuid: number }) {
  const { data: res, isPending, isError } = useQuery(subnetStakeMovesQuery(netuid));
  const card = res?.data;
  const m = stakeMovesTileModel(card);
  const value = isError ? "—" : isPending && !card ? "…" : formatNumber(m.movements);
  return (
    <StatTile
      eyebrow="Stake moves"
      tone="accent"
      value={value}
      hint={`${m.movers} mover${m.movers === 1 ? "" : "s"}`}
      chart={
        <SparkLegend
          metric="Stake moves"
          source={`On-chain StakeMoved (re-delegation) events for SN${netuid} over the trailing 30-day window — ${m.summary}.`}
          windowLabel={card?.window ?? "30d"}
          updatedAt={card?.observed_at ?? null}
          staleness="Counts settle as the chain-events indexer catches up; the bar hides when no re-delegations occurred in the window."
        >
          <span className="flex w-[72px] items-center gap-1.5">
            <span className="w-6 text-right font-mono text-[11px] tabular-nums text-ink">
              {m.perMover != null ? `${m.perMover.toFixed(1)}×` : "—"}
            </span>
            <span className="max-w-[56px] flex-1">
              <MiniStack segments={m.segments} height={6} />
            </span>
          </span>
        </SparkLegend>
      }
    />
  );
}

// #3484: recent stake-transfer activity for a subnet, 30-day window, from the
// already-shipped subnetStakeTransfersQuery. Like the sibling stake-moves tile,
// the endpoint returns a flat window aggregate (count / distinct senders / avg)
// rather than a series, so it renders as a single StatTile using the MiniStack +
// SparkLegend single-snapshot idiom. The MiniStack splits the total into unique
// senders vs repeat transfers so the lone aggregate still reads as a composition.
function StakeTransfersTile({ netuid }: { netuid: number }) {
  const { data: res, isPending, isError } = useQuery(subnetStakeTransfersQuery(netuid));
  const card = res?.data;
  const m = stakeTransfersTileModel(card);
  const value = isError ? "—" : isPending && !card ? "…" : formatNumber(m.transfers);
  return (
    <StatTile
      eyebrow="Stake transfers"
      tone="accent"
      value={value}
      hint={`${m.senders} sender${m.senders === 1 ? "" : "s"}`}
      chart={
        <SparkLegend
          metric="Stake transfers"
          source={`On-chain stake-transfer events for SN${netuid} over the trailing 30-day window — ${m.summary}.`}
          windowLabel={card?.window ?? "30d"}
          updatedAt={card?.observed_at ?? null}
          staleness="Counts settle as the chain-events indexer catches up; the bar hides when no transfers occurred in the window."
        >
          <span className="flex w-[72px] items-center gap-1.5">
            <span className="w-6 text-right font-mono text-[11px] tabular-nums text-ink">
              {m.perSender != null ? `${m.perSender.toFixed(1)}×` : "—"}
            </span>
            <span className="max-w-[56px] flex-1">
              <MiniStack segments={m.segments} height={6} />
            </span>
          </span>
        </SparkLegend>
      }
    />
  );
}

export function EconomicsPanel({ netuid }: { netuid: number }) {
  const { data: res, isPending } = useQuery(economicsQuery());
  const e = res?.data.find((x) => x.netuid === netuid);

  // #3362: alpha-price trend for the "Alpha price" tile, from the already-shipped
  // subnetTrajectoryQuery — same points.alpha_price_tao extraction as
  // subnet-price-ticker.tsx. Fetched alongside economicsQuery() but never gates the
  // panel's own loading/empty states, which stay keyed off economicsQuery() only.
  const { data: trajRes } = useQuery(subnetTrajectoryQuery(netuid));
  const pricePoints: SparklinePoint[] = (trajRes?.data.points ?? []).flatMap((p) =>
    typeof p.alpha_price_tao === "number" && Number.isFinite(p.alpha_price_tao)
      ? [{ t: p.date, v: p.alpha_price_tao }]
      : [],
  );
  const priceValues = pricePoints.map((p) => p.v);

  if (isPending && !e) return <Notice>Loading economics…</Notice>;
  if (!e) return <Notice>No on-chain economic data for this subnet.</Notice>;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        eyebrow="Emission share"
        tone="accent"
        value={e.emission_share != null ? `${(e.emission_share * 100).toFixed(3)}%` : "—"}
      />
      <StatTile
        eyebrow="Alpha price"
        value={e.alpha_price_tao != null ? `${e.alpha_price_tao.toFixed(4)} τ` : "—"}
        chart={
          <Sparkline
            values={priceValues}
            points={pricePoints}
            width={72}
            height={28}
            formatValue={(v) => `${v.toFixed(4)} τ`}
            ariaLabel="Alpha price trend"
          />
        }
      />
      <StatTile
        eyebrow="Validators"
        value={
          e.validator_count != null
            ? `${e.validator_count}${e.max_validators ? ` / ${e.max_validators}` : ""}`
            : "—"
        }
      />
      <StatTile
        eyebrow="Miners"
        value={formatNumber(e.miner_count)}
        hint={e.max_uids ? `${e.max_uids} max UIDs` : undefined}
      />
      <StatTile eyebrow="Total stake" value={fmtTao(e.total_stake_tao)} />
      <StatTile eyebrow="Volume" value={fmtTao(e.subnet_volume_tao)} />
      <StatTile eyebrow="Max stake" value={fmtTao(e.max_stake_tao)} />
      <StatTile
        eyebrow="Registration"
        tone={e.registration_allowed === false ? "down" : "default"}
        value={e.registration_cost_tao != null ? `${e.registration_cost_tao} τ` : "—"}
        hint={e.registration_allowed === false ? "closed" : "open"}
      />
      <StakeMovesTile netuid={netuid} />
      <StakeTransfersTile netuid={netuid} />
    </div>
  );
}
