import { useQuery } from "@tanstack/react-query";
import {
  economicsQuery,
  subnetRecycledQuery,
  subnetIdleStakeQuery,
  subnetStakeMovesQuery,
  subnetStakeTransfersQuery,
  subnetBurnHistoryQuery,
} from "@/lib/metagraphed/queries";
import { FactCell } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { stakeMovesTileModel } from "@/lib/metagraphed/stake-moves-tile";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import { stakeTransfersTileModel } from "@/lib/metagraphed/stake-transfers-tile";

// #1112: per-subnet on-chain economics (emission share, alpha price, stake,
// validators, volume) from the previously-unused /api/v1/economics. The artifact
// carries all subnets; we fetch once (shared cache) and find this netuid.
// #3364: the tiered τ formatter now lives in lib/format (formatTao) so this
// panel and the /subnets table Registration column share one source of truth.

function Notice({ children }: { children: string }) {
  return <Panel bodyClassName="text-13 text-ink-muted">{children}</Panel>;
}

// #3485: re-delegation (StakeMoved) activity for this subnet over the trailing
// 30-day window, from the already-shipped subnetStakeMovesQuery. The endpoint
// returns a flat window aggregate (count / distinct movers / avg) rather than a
// series, so — per the issue — it renders as a single FactCell using the
// MiniStack + Provenance single-snapshot idiom instead of a literal chart. The
// MiniStack splits the total into unique movers vs repeat moves so the lone
// aggregate still reads as a composition.
function StakeMovesTile({ netuid }: { netuid: number }) {
  const { data: res, isPending, isError } = useQuery(subnetStakeMovesQuery(netuid));
  const card = res?.data;
  const m = stakeMovesTileModel(card);
  const value = isError ? "—" : isPending && !card ? "…" : formatNumber(m.movements);
  return (
    <FactCell
      label="Stake moves"
      value={value}
      hint={`${m.movers} mover${m.movers === 1 ? "" : "s"}`}
    />
  );
}

// #3484: recent stake-transfer activity for a subnet, 30-day window, from the
// already-shipped subnetStakeTransfersQuery. Like the sibling stake-moves tile,
// the endpoint returns a flat window aggregate (count / distinct senders / avg)
// rather than a series, so it renders as a single FactCell using the MiniStack +
// Provenance single-snapshot idiom. The MiniStack splits the total into unique
// senders vs repeat transfers so the lone aggregate still reads as a composition.
function StakeTransfersTile({ netuid }: { netuid: number }) {
  const { data: res, isPending, isError } = useQuery(subnetStakeTransfersQuery(netuid));
  const card = res?.data;
  const m = stakeTransfersTileModel(card);
  const value = isError ? "—" : isPending && !card ? "…" : formatNumber(m.transfers);
  return (
    <FactCell
      label="Stake transfers"
      value={value}
      hint={`${m.senders} sender${m.senders === 1 ? "" : "s"}`}
    />
  );
}

// #4339/8.4: cumulative TAO recycled for registration on this subnet, queried
// live from the chain (600s KV cache on the backend) rather than the
// account_events log-layer aggregations the sibling stake tiles above use --
// see subnet-recycled.ts's header for why. recycled_tao stays "—" (not "0")
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
  return <FactCell label="Recycled TAO" value={value} hint="cumulative · live RPC" />;
}

// #6994: stake delegated to hotkeys currently earning zero dividends (no permit
// or zero-weight outcome) — idle capital a delegator could redeploy. idle_stake_tao
// stays "—" (not "0") on a cold snapshot, since 0 is a real, distinct value.
function IdleStakeTile({ netuid }: { netuid: number }) {
  const { data: res, isPending, isError } = useQuery(subnetIdleStakeQuery(netuid));
  const idle = res?.data.idle_stake_alpha;
  const count = res?.data.idle_neuron_count;
  const value = isError
    ? "—"
    : isPending && idle == null
      ? "…"
      : idle == null
        ? "—"
        : formatTao(idle);
  return (
    <FactCell
      label="Idle stake"
      value={value}
      hint={
        count != null
          ? `zero-dividend · ${formatNumber(count)} idle hotkey${count === 1 ? "" : "s"}`
          : "zero-dividend delegated stake"
      }
    />
  );
}

// #10300: the registration cost had a live value and no series, so "is this
// subnet getting more or less expensive" -- the question the burn capture was
// built for (#9402) -- was unanswerable from the UI while the data sat in
// subnet_burn_history unread.
//
// The MOVEMENT comes from the route, never from the points. /burn/history caps
// at 2,000 newest-first, so a client-side first-vs-last would silently measure
// the page rather than the window; `change_tao`/`change_pct` are computed over
// the whole window server-side.
//
// The live cost stays the tile's headline rather than the series' last point:
// they come from different reads (economics is a pinned capture, /burn is a
// live RPC), and showing the series' tail as "the price" would quietly age the
// number by up to a tick.
function RegistrationTile({
  netuid,
  costTao,
  allowed,
}: {
  netuid: number;
  costTao: number | null;
  allowed: boolean;
}) {
  const { data: res } = useQuery(subnetBurnHistoryQuery(netuid, "7d"));
  const card = res?.data;
  const points: Array<{ t: string; v: number }> = (card?.points ?? []).map((p) => ({
    t: p.observed_at,
    v: p.burn_tao,
  }));
  const pct = card?.change_pct;
  // A flat series is the common case (most subnets re-price rarely), so the
  // hint says "flat" rather than "0.0%" -- a signed zero reads as a measurement
  // that moved and landed back, which is not what happened.
  const movement =
    typeof pct === "number" && Number.isFinite(pct) && pct !== 0
      ? `${pct > 0 ? "+" : ""}${pct.toFixed(1)}% 7d`
      : points.length > 1
        ? "flat 7d"
        : null;
  return (
    <FactCell
      label="Registration"
      value={costTao != null ? `${costTao} τ` : "—"}
      hint={[allowed ? "open" : "closed", movement].filter(Boolean).join(" · ")}
    />
  );
}

export function EconomicsPanel({ netuid }: { netuid: number }) {
  const { data: res, isPending } = useQuery(economicsQuery());
  const e = res?.data.find((x) => x.netuid === netuid);

  if (isPending && !e) return <Notice>Loading economics…</Notice>;
  if (!e) return <Notice>No on-chain economic data for this subnet.</Notice>;

  return (
    <div className="space-y-3">
      <div className="flex justify-end"></div>
      {/* Flex-wrap (not grid) so a trailing partial row's tiles stretch to fill
          the row instead of leaving empty column slots — grid tracks are shared
          across every row, but flex lines size independently (same pattern as
          the stat spine in subnet-masthead.tsx / operational-panel.tsx). */}
      <div className="flex flex-wrap gap-3 [&>*]:grow [&>*]:basis-[200px]">
        <FactCell
          label="Emission share"
          value={e.emission_share != null ? `${(e.emission_share * 100).toFixed(3)}%` : "—"}
          hint="Stage 1 of the v440 emission pipeline: this subnet's share of alpha price (alpha_price / total), NOT the share of TAO it receives. Spec 440 separates the two by miner-burn reweighting, the Hill emission gate, the enabled filter, and the alpha injection cap."
        />
        <FactCell
          label="Alpha price"
          value={e.alpha_price_tao != null ? `${e.alpha_price_tao.toFixed(4)} τ` : "—"}
        />
        <FactCell
          label="Validators"
          value={
            e.validator_count != null
              ? `${e.validator_count}${e.max_validators ? ` / ${e.max_validators}` : ""}`
              : "—"
          }
        />
        <FactCell
          label="Miners"
          value={formatNumber(e.miner_count)}
          hint={e.max_uids ? `${e.max_uids} max UIDs` : undefined}
        />
        <FactCell label="Total stake" value={formatTao(e.total_stake_alpha)} />
        <FactCell label="Volume" value={formatTao(e.subnet_volume_tao)} />
        <FactCell label="Max stake" value={formatTao(e.max_stake_tao)} />
        <FactCell label="Market cap" value={formatTao(e.alpha_market_cap_tao)} hint="proxy" />
        <FactCell label="FDV" value={formatTao(e.alpha_fdv_tao)} hint="proxy" />
        <RegistrationTile
          netuid={netuid}
          costTao={e.registration_cost_tao ?? null}
          allowed={e.registration_allowed !== false}
        />
        <RecycledTaoTile netuid={netuid} />
        <IdleStakeTile netuid={netuid} />
        <StakeMovesTile netuid={netuid} />
        <StakeTransfersTile netuid={netuid} />
      </div>
    </div>
  );
}
