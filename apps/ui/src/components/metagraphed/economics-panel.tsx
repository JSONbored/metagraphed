import { useQuery } from "@tanstack/react-query";
import {
  economicsQuery,
  subnetRecycledQuery,
  subnetIdleStakeQuery,
  subnetStakeMovesQuery,
  subnetStakeTransfersQuery,
  subnetTrajectoryQuery,
} from "@/lib/metagraphed/queries";
import {
  StatTile,
  MiniStack,
  SparkLegend,
  Sparkline,
  RealtimeFreshness,
  type SparklinePoint,
} from "@jsonbored/ui-kit";
import { stakeMovesTileModel } from "@/lib/metagraphed/stake-moves-tile";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import { stakeTransfersTileModel } from "@/lib/metagraphed/stake-transfers-tile";

// #1112: per-subnet on-chain economics (emission share, alpha price, stake,
// validators, volume) from the previously-unused /api/v1/economics. The artifact
// carries all subnets; we fetch once (shared cache) and find this netuid.
// #3364: the tiered τ formatter now lives in lib/format (formatTao) so this
// panel and the /subnets table Registration column share one source of truth.

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
          source={`On-chain StakeMoved (re-delegation) events for SN${netuid} over the trailing ${card?.window ?? "30d"} window — ${m.summary}.`}
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
          source={`On-chain stake-transfer events for SN${netuid} over the trailing ${card?.window ?? "30d"} window — ${m.summary}.`}
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

// #4339/8.4: cumulative TAO recycled for registration on this subnet, queried
// live from the chain (600s KV cache on the backend) rather than the
// account_events log-layer aggregations the sibling stake tiles above use --
// see subnet-recycled.mjs's header for why. recycled_tao stays "—" (not "0")
// on an RPC failure, since 0 is a real, distinct value here.
function RecycledTaoTile({ netuid }: { netuid: number }) {
  const { data: res, isPending, isError } = useQuery(subnetRecycledQuery(netuid));
  const recycled = res?.data.recycled_tao;
  const value = isError
    ? "—"
    : isPending && recycled == null
      ? "…"
      : recycled == null
        ? "—"
        : formatTao(recycled);
  return <StatTile eyebrow="Recycled TAO" value={value} hint="cumulative · live RPC" />;
}

// #6994: stake delegated to hotkeys currently earning zero dividends (no permit
// or zero-weight outcome) — idle capital a delegator could redeploy. idle_stake_tao
// stays "—" (not "0") on a cold snapshot, since 0 is a real, distinct value.
function IdleStakeTile({ netuid }: { netuid: number }) {
  const { data: res, isPending, isError } = useQuery(subnetIdleStakeQuery(netuid));
  const idle = res?.data.idle_stake_tao;
  const count = res?.data.idle_neuron_count;
  const value = isError
    ? "—"
    : isPending && idle == null
      ? "…"
      : idle == null
        ? "—"
        : formatTao(idle);
  return (
    <StatTile
      eyebrow="Idle stake"
      value={value}
      hint={
        count != null
          ? `zero-dividend · ${formatNumber(count)} idle hotkey${count === 1 ? "" : "s"}`
          : "zero-dividend delegated stake"
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
    <div className="space-y-3">
      <div className="flex justify-end">
        <RealtimeFreshness at={res?.meta?.generated_at} />
      </div>
      {/* Flex-wrap (not grid) so a trailing partial row's tiles stretch to fill
          the row instead of leaving empty column slots — grid tracks are shared
          across every row, but flex lines size independently (same pattern as
          the stat spine in subnet-masthead.tsx / operational-panel.tsx). */}
      <div className="flex flex-wrap gap-3 [&>*]:grow [&>*]:basis-[200px]">
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
        <StatTile eyebrow="Total stake" value={formatTao(e.total_stake_tao)} />
        <StatTile eyebrow="Volume" value={formatTao(e.subnet_volume_tao)} />
        <StatTile eyebrow="Max stake" value={formatTao(e.max_stake_tao)} />
        <StatTile eyebrow="Market cap" value={formatTao(e.alpha_market_cap_tao)} hint="proxy" />
        <StatTile eyebrow="FDV" value={formatTao(e.alpha_fdv_tao)} hint="proxy" />
        <StatTile
          eyebrow="Registration"
          tone={e.registration_allowed === false ? "down" : "default"}
          value={e.registration_cost_tao != null ? `${e.registration_cost_tao} τ` : "—"}
          hint={e.registration_allowed === false ? "closed" : "open"}
        />
        <RecycledTaoTile netuid={netuid} />
        <IdleStakeTile netuid={netuid} />
        <StakeMovesTile netuid={netuid} />
        <StakeTransfersTile netuid={netuid} />
      </div>
    </div>
  );
}
