import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRightLeft, Coins } from "lucide-react";
import { useQueries, useSuspenseQuery } from "@tanstack/react-query";
import { CopyButton, StatTile } from "@jsonbored/ui-kit";
import {
  accountPortfolioQuery,
  accountPositionsQuery,
  economicsQuery,
  subnetStakeQuoteQuery,
} from "@/lib/metagraphed/queries";
import { StakeUnstakeModal } from "@/components/metagraphed/stake-unstake-modal";
import { MoveStakeModal } from "@/components/metagraphed/move-stake-modal";
import { EmptyState } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import { classNames } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import type { SubnetEconomics } from "@/lib/metagraphed/types";

/** One row of the portfolio, unified across the hotkey-owned and delegated feeds. */
export interface UnifiedPosition {
  key: string;
  /** `owned` = the wallet's own neuron (hotkey portfolio); `delegated` = stake nominated to a validator. */
  source: "owned" | "delegated";
  netuid: number;
  /** The validator hotkey the stake sits with (delegated), or the owned neuron's hotkey when present. */
  hotkey: string | null;
  /** Spot mark: the position's current TAO value (alpha x price). */
  spotTao: number;
  /** Emission-per-stake return; only the owned feed carries it. */
  yield: number | null;
  /** Derived alpha amount (spotTao / alpha price); null for root (netuid 0, TAO 1:1) or an unknown price. */
  alpha: number | null;
  isRoot: boolean;
}

/** #5243: fold the two position feeds into one spot-sorted list, deriving each
 *  alpha holding from the per-subnet price so an exit quote can be requested. */
export function buildUnifiedPositions(
  ownedPositions: ReadonlyArray<Record<string, unknown>>,
  delegatedPositions: ReadonlyArray<Record<string, unknown>>,
  priceByNetuid: ReadonlyMap<number, number>,
): UnifiedPosition[] {
  const derive = (netuid: number, spotTao: number) => {
    const price = priceByNetuid.get(netuid);
    return netuid === 0 || !price || price <= 0 ? null : spotTao / price;
  };
  const owned = ownedPositions.map((p, i) => {
    const netuid = Number(p.netuid);
    const spotTao = typeof p.stake_tao === "number" ? p.stake_tao : 0;
    return {
      key: `owned-${netuid}-${p.uid ?? i}`,
      source: "owned" as const,
      netuid,
      hotkey: typeof p.hotkey === "string" ? p.hotkey : null,
      spotTao,
      yield: typeof p.yield === "number" ? p.yield : null,
      alpha: derive(netuid, spotTao),
      isRoot: netuid === 0,
    };
  });
  const delegated = delegatedPositions.map((p, i) => {
    const netuid = Number(p.netuid);
    const spotTao = typeof p.stake_tao === "number" ? p.stake_tao : 0;
    return {
      key: `deleg-${typeof p.hotkey === "string" ? p.hotkey : i}-${netuid}`,
      source: "delegated" as const,
      netuid,
      hotkey: typeof p.hotkey === "string" ? p.hotkey : null,
      spotTao,
      yield: null,
      alpha: derive(netuid, spotTao),
      isRoot: netuid === 0,
    };
  });
  return [...owned, ...delegated].sort((a, b) => b.spotTao - a.spotTao);
}

const pct = (v: number | null) =>
  v != null && Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "—";

export function YourPositionsPanel({ address }: { address: string }) {
  const portfolio = useSuspenseQuery(accountPortfolioQuery(address)).data.data;
  const nominator = useSuspenseQuery(accountPositionsQuery(address)).data.data;
  const economics = useSuspenseQuery(economicsQuery()).data.data as SubnetEconomics[];

  const priceByNetuid = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of economics ?? []) {
      if (typeof e.alpha_price_tao === "number") m.set(e.netuid, e.alpha_price_tao);
    }
    return m;
  }, [economics]);

  const positions = useMemo(
    () =>
      buildUnifiedPositions(
        (portfolio.positions ?? []) as Record<string, unknown>[],
        (nominator.positions ?? []) as unknown as Record<string, unknown>[],
        priceByNetuid,
      ),
    [portfolio, nominator, priceByNetuid],
  );

  // Simulated exit: unstaking the derived alpha through the AMM (fee + slippage),
  // per position. Root positions have no AMM (TAO 1:1), so their exit == spot and
  // no quote is fetched.
  const quotes = useQueries({
    queries: positions.map((p) => ({
      // Homogeneous query-options so useQueries infers one result type. Root /
      // unknown-price rows pass a placeholder amount but are disabled, so no
      // request fires and their exit falls back to spot in exitTaoFor.
      ...subnetStakeQuoteQuery(p.netuid, p.alpha && p.alpha > 0 ? p.alpha : 1, "unstake"),
      enabled: Boolean(p.alpha && p.alpha > 0),
    })),
  });

  const exitTaoFor = (index: number, p: UnifiedPosition): number | null => {
    if (p.isRoot) return p.spotTao; // no AMM, 1:1
    const out = quotes[index]?.data?.data?.expected_out;
    return typeof out === "number" ? out : null;
  };

  const totals = useMemo(() => {
    let spot = 0;
    let exit = 0;
    let root = 0;
    let alpha = 0;
    positions.forEach((p, i) => {
      spot += p.spotTao;
      exit += exitTaoFor(i, p) ?? p.spotTao;
      if (p.isRoot) root += p.spotTao;
      else alpha += p.spotTao;
    });
    return { spot, exit, root, alpha };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, quotes]);

  if (positions.length === 0) {
    return (
      <EmptyState
        title="No positions for this wallet"
        description="This wallet holds no stake on any subnet — neither a registered neuron nor a delegation. Positions appear here once it stakes."
        lastChecked={portfolio.captured_at ?? undefined}
      />
    );
  }

  const rootPct = totals.spot > 0 ? totals.root / totals.spot : null;

  return (
    <div className="space-y-8">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          icon={Coins}
          eyebrow="Total value (spot)"
          value={`${taoCompact(totals.spot)} τ`}
          hint={`${positions.length} position${positions.length === 1 ? "" : "s"}`}
          tone="accent"
        />
        <StatTile
          icon={Coins}
          eyebrow="Simulated exit"
          value={`${taoCompact(totals.exit)} τ`}
          hint="after fee + slippage"
        />
        <StatTile
          icon={Coins}
          eyebrow="Root / Alpha split"
          value={`${taoCompact(totals.root)} / ${taoCompact(totals.alpha)} τ`}
          hint={rootPct != null ? `${(rootPct * 100).toFixed(1)}% root` : "—"}
        />
      </div>

      {/* Desktop table */}
      <Panel as="div" flush className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
            <tr>
              <th className="px-3 py-2.5 text-left">Subnet</th>
              <th className="px-3 py-2.5 text-left">Source</th>
              <th className="px-3 py-2.5 text-left">Hotkey</th>
              <th className="px-3 py-2.5 text-right">Spot τ</th>
              <th className="px-3 py-2.5 text-right">Exit τ</th>
              <th className="px-3 py-2.5 text-right">Yield</th>
              <th className="px-3 py-2.5 text-right">Manage</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p, i) => (
              <tr key={p.key} className="mg-row-hover border-t border-border/60">
                <td className="px-3 py-2.5 font-mono text-[12px]">
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: p.netuid }}
                    className="text-ink-strong hover:text-accent hover:underline"
                  >
                    {p.isRoot ? "Root" : `SN${p.netuid}`}
                  </Link>
                </td>
                <td className="px-3 py-2.5">
                  <SourceBadge source={p.source} />
                </td>
                <td className="px-3 py-2.5 font-mono text-[11px] text-ink-muted">
                  {p.hotkey ? <HotkeyCell hotkey={p.hotkey} /> : "—"}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-strong">
                  {taoCompact(p.spotTao)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                  {taoCompact(exitTaoFor(i, p))}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-muted">
                  {pct(p.yield)}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <div className="inline-flex items-center gap-1.5">
                    <ManageButton hotkey={p.hotkey} netuid={p.netuid} />
                    <MoveButton
                      hotkey={p.hotkey}
                      netuid={p.netuid}
                      positionAlpha={p.alpha}
                      positionSpotTao={p.spotTao}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {positions.map((p, i) => (
          <Panel as="div" dense bodyClassName="space-y-2" key={p.key}>
            <div className="flex items-center justify-between gap-2">
              <Link
                to="/subnets/$netuid"
                params={{ netuid: p.netuid }}
                className="font-mono text-[12px] text-ink-strong hover:text-accent hover:underline"
              >
                {p.isRoot ? "Root" : `SN${p.netuid}`}
              </Link>
              <SourceBadge source={p.source} />
            </div>
            {p.hotkey ? (
              <div className="font-mono text-[11px] text-ink-muted">
                <HotkeyCell hotkey={p.hotkey} />
              </div>
            ) : null}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
              <Stat label="Spot τ" value={taoCompact(p.spotTao)} />
              <Stat label="Exit τ" value={taoCompact(exitTaoFor(i, p))} />
              <Stat label="Yield" value={pct(p.yield)} />
            </dl>
            <div className="flex items-center gap-1.5">
              <ManageButton hotkey={p.hotkey} netuid={p.netuid} />
              <MoveButton
                hotkey={p.hotkey}
                netuid={p.netuid}
                positionAlpha={p.alpha}
                positionSpotTao={p.spotTao}
              />
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: "owned" | "delegated" }) {
  return (
    <span
      className={classNames(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-wider",
        source === "owned"
          ? "border-accent/40 bg-accent-surface text-accent-text"
          : "border-border bg-surface/40 text-ink-muted",
      )}
    >
      {source === "owned" ? "Owned" : "Delegated"}
    </span>
  );
}

function HotkeyCell({ hotkey }: { hotkey: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Link
        to="/validators/$hotkey"
        params={{ hotkey }}
        title={hotkey}
        className="hover:text-ink hover:underline"
      >
        {shortHash(hotkey) ?? hotkey}
      </Link>
      <CopyButton value={hotkey} label="hotkey" compact />
    </span>
  );
}

function ManageButton({ hotkey, netuid }: { hotkey: string | null; netuid: number }) {
  if (!hotkey) return <span className="font-mono text-[10px] text-ink-subtle-text">—</span>;
  return (
    <StakeUnstakeModal
      hotkey={hotkey}
      netuid={netuid}
      trigger={(open) => (
        <button
          type="button"
          onClick={open}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink-strong transition-colors hover:border-accent/50 hover:text-accent"
        >
          <Coins className="size-3 text-ink-muted" aria-hidden />
          Manage
        </button>
      )}
    />
  );
}

/** #5244: "Move this position" -- a second entry point alongside Manage, opening the move/re-delegate flow for this exact (hotkey, netuid) position. */
function MoveButton({
  hotkey,
  netuid,
  positionAlpha,
  positionSpotTao,
}: {
  hotkey: string | null;
  netuid: number;
  positionAlpha: number | null;
  positionSpotTao: number;
}) {
  if (!hotkey) return null;
  return (
    <MoveStakeModal
      hotkey={hotkey}
      netuid={netuid}
      positionAlpha={positionAlpha}
      positionSpotTao={positionSpotTao}
      trigger={(open) => (
        <button
          type="button"
          onClick={open}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink-strong transition-colors hover:border-accent/50 hover:text-accent"
        >
          <ArrowRightLeft className="size-3 text-ink-muted" aria-hidden />
          Move
        </button>
      )}
    />
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-mono tabular-nums text-ink">{value}</dd>
    </div>
  );
}
