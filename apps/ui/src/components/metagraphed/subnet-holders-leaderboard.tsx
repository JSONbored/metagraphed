import { useQuery } from "@tanstack/react-query";
import { Database } from "lucide-react";
import { subnetHoldersQuery } from "@/lib/metagraphed/queries";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { RealtimeFreshness } from "@jsonbored/ui-kit";
import { formatNumber } from "@/lib/metagraphed/format";

/**
 * Alpha, already in WHOLE UNITS.
 *
 * Deliberately NOT the `fmtAlpha` in subnet-conviction-leaderboard.tsx, which
 * divides by 1e9 because conviction/locked_mass arrive rao-scale. This route's
 * producer converts before writing (`rao_to_alpha_f64` in the poller's
 * hotkey_alpha job), so `total_alpha` is stored in whole alpha and
 * `share_fraction * total_alpha` comes out the same way. Dividing again would
 * report every holder as a billionth of its real size, which looks like a
 * plausible dust balance rather than an obvious bug.
 */
function fmtAlpha(alpha: number): string {
  if (!Number.isFinite(alpha)) return "—";
  const magnitude = Math.abs(alpha);
  if (magnitude >= 1_000_000) return `${(alpha / 1_000_000).toFixed(2)}M α`;
  if (magnitude >= 1_000) return `${(alpha / 1_000).toFixed(1)}k α`;
  if (magnitude >= 1) return `${alpha.toFixed(2)} α`;
  if (alpha === 0) return "0 α";
  return `${alpha.toFixed(4)} α`;
}

/** A share as a percentage, or an em dash. Null is "no share to state" -- with
 * no measured total there is no denominator -- and must never render as 0%. */
function pctStr(share: number | null): string {
  if (share == null || !Number.isFinite(share)) return "—";
  const pct = share * 100;
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(3)}%`;
}

/**
 * Why the ranking could not be produced, in the caller's words.
 *
 * Rendered as an informational notice rather than a red ErrorState or a dashed
 * EmptyState, matching DataTierUnavailableNotice/NativeOnlyNotice: nothing has
 * failed and nothing is missing -- the route is declining to rank data it
 * cannot prove. An EmptyState here would read as "this subnet has no holders",
 * which is the one thing a decline specifically does not claim.
 */
const DECLINE_COPY: Record<string, { title: string; body: string }> = {
  pool_totals_unproven: {
    title: "Holder ranking not available yet",
    body: "Ranking holders needs the per-hotkey alpha pool totals, and the ledger that carries them has not completed a full pass yet. A partial ledger would under-price holders rather than visibly omit them, so this ranking is withheld instead of shown wrong. It appears on its own once a pass lands.",
  },
  root_not_in_alpha_map: {
    title: "Root has no alpha holders",
    body: "Root stake is not denominated in alpha and does not appear in the chain's Alpha map, so there is no holder set to rank here. This is a property of root, not a gap in the data.",
  },
  unavailable: {
    title: "Holder ranking could not be read",
    body: "The ledger behind this ranking could not be reached for this request. It is unrelated to the rest of this page.",
  },
};

function DeclineNotice({ reason }: { reason: string }) {
  const copy = DECLINE_COPY[reason] ?? {
    title: "Holder ranking not available",
    body: "This ranking is being withheld rather than shown from data that cannot be verified.",
  };
  return (
    <div role="status" className="rounded border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <Database className="size-4 shrink-0 text-ink-muted" />
        <div className="min-w-0 flex-1">
          <div className="mb-1 font-display text-sm font-medium text-ink-strong">{copy.title}</div>
          <p className="text-xs leading-relaxed text-ink-muted">{copy.body}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * Who owns a subnet's alpha (#9557, frontend companion #9597).
 *
 * The reverse index of an account's own positions: this asks a subnet who
 * holds it, where /accounts/{ss58}/positions asks a wallet what it holds. It is
 * NOT the same question as the concentration panel beside it -- that one reads
 * registered UIDs' stake and emits scalars (Gini/HHI/Nakamoto), so it cannot
 * see alpha parked on hotkeys that hold no UID on this subnet. On netuid 74
 * that is 82 of the 92 hotkeys carrying positions.
 *
 * THREE OUTCOMES, AND THEY ARE NOT INTERCHANGEABLE. A decline (a `degraded`
 * block) renders an informational notice; a genuine empty holder set renders an
 * EmptyState; a fetch failure renders an ErrorState. The decline branch is
 * checked FIRST precisely because both it and the measurement arrive as
 * `holders: []` -- ordering them the other way would report "no holders" for a
 * subnet nobody has ranked yet.
 */
export function SubnetHoldersLeaderboard({ netuid }: { netuid: number }) {
  const { data: res, isLoading, isError, error, refetch } = useQuery(subnetHoldersQuery(netuid));
  const data = res?.data;

  if (isError) {
    return <ErrorState error={error} onRetry={() => refetch()} context="subnet holders" />;
  }

  if (isLoading) {
    return <Skeleton className="h-40 w-full" />;
  }

  // BEFORE the empty check: a decline also carries an empty `holders`.
  if (data?.degraded?.reason) {
    return <DeclineNotice reason={data.degraded.reason} />;
  }

  const holders = data?.holders ?? [];

  if (holders.length === 0) {
    return (
      <EmptyState
        title="No alpha holders"
        description="No account currently holds alpha on this subnet through a stake position. This is a measurement, not a missing ranking."
      />
    );
  }

  const conc = data?.concentration;

  return (
    <div className="space-y-3">
      {/* Two lines, not one run-on strip. The first states the SET being ranked
          (and that holder_count describes the whole subnet rather than the rows
          on screen -- a reader looking at 20 rows would otherwise reasonably
          read it as describing them); the second is concentration, which is a
          different question and was previously wrapping into the middle of the
          first at 375px. */}
      <div className="space-y-1 mg-type-data text-ink-muted">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {data?.holder_count != null ? (
            <span className="text-ink">
              <span className="font-mono tabular-nums text-ink-strong">
                {formatNumber(data.holder_count)}
              </span>{" "}
              holders
            </span>
          ) : null}
          {data?.total_alpha != null ? (
            <span>
              · <span className="font-mono tabular-nums">{fmtAlpha(data.total_alpha)}</span> held
            </span>
          ) : null}
          {data?.holder_count != null && holders.length < data.holder_count ? (
            <span>· top {holders.length} shown</span>
          ) : null}
          {data?.captured_at ? <RealtimeFreshness at={data.captured_at} /> : null}
        </div>
        {conc?.top5_share != null || conc?.top10_share != null || conc?.top20_share != null ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="mg-type-caption uppercase tracking-wide">Top</span>
            {(
              [
                ["5", conc?.top5_share ?? null],
                ["10", conc?.top10_share ?? null],
                ["20", conc?.top20_share ?? null],
              ] as const
            ).map(([label, share]) =>
              share == null ? null : (
                <span key={label} className="whitespace-nowrap">
                  {label} <span className="font-mono tabular-nums text-ink">{pctStr(share)}</span>
                </span>
              ),
            )}
          </div>
        ) : null}
      </div>
      <Panel as="div" flush className="overflow-hidden">
        {/* MOBILE IS A RANKED LIST, NOT A TABLE OF LABELLED FIELDS.
            
            The first attempt rendered the four columns as `Alpha 41.2k α Share
            27.1% Hotkeys 3` under each address -- readable, and wrong for what
            this is. Three failures, all of them about a leaderboard not looking
            like one: no rank at all, the address (the least interesting field)
            set as the most prominent thing, and the ranking key buried in a
            run-on label row at the same weight as the hotkey count.
            
            So: rank leads, alpha is the dominant figure, and the share becomes a
            BAR -- concentration is the actual question this section answers, and
            a bar answers it at a glance where a column of percentages does not.
            The repeated field labels are gone; position and the bar carry the
            meaning instead, which is also what buys back the width that pushed
            a column off-screen in the first place. */}
        <ul className="divide-y divide-border/60 md:hidden">
          {holders.map((entry, i) => (
            <li key={entry.coldkey} className="space-y-1.5 px-4 py-3">
              <div className="flex items-baseline gap-2">
                <span className="w-6 shrink-0 font-mono mg-type-caption tabular-nums text-ink-muted">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <AddressDisplay ss58={entry.coldkey} fallback="—" compact />
                </div>
                <span className="shrink-0 font-mono text-sm tabular-nums whitespace-nowrap text-ink-strong">
                  {fmtAlpha(entry.alpha)}
                </span>
              </div>
              <div className="flex items-center gap-2 pl-8">
                {/* Same 3px track/fill the author-share panel uses. aria-hidden
                    because the percentage beside it is the accessible value --
                    the bar is redundant encoding, not the only one. */}
                <div
                  aria-hidden
                  className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-border/60"
                >
                  <div
                    className="h-full rounded-full bg-accent/70"
                    style={{ width: `${Math.min(100, (entry.share_of_total ?? 0) * 100)}%` }}
                  />
                </div>
                <span className="shrink-0 font-mono mg-type-caption tabular-nums whitespace-nowrap text-ink-muted">
                  {pctStr(entry.share_of_total)}
                </span>
                {/* Only when it says something. One hotkey is the default case
                    and a "1" on every row is noise; null means unread, not one. */}
                {entry.hotkey_count != null && entry.hotkey_count > 1 ? (
                  <span className="shrink-0 mg-type-caption whitespace-nowrap text-ink-muted">
                    {formatNumber(entry.hotkey_count)} hotkeys
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface/40">
              <tr>
                <th className="px-4 py-2.5 mg-type-micro text-ink-muted">#</th>
                <th className="px-4 py-2.5 mg-type-micro text-ink-muted">Coldkey</th>
                <th className="px-4 py-2.5 text-right mg-type-micro text-ink-muted">Alpha</th>
                <th className="px-4 py-2.5 text-right mg-type-micro text-ink-muted">Share</th>
                <th className="px-4 py-2.5 text-right mg-type-micro text-ink-muted">Hotkeys</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {holders.map((entry, i) => (
                <tr key={entry.coldkey} className="mg-row-accent hover:bg-surface/40">
                  {/* Rank, because this is a leaderboard -- the order carries
                      meaning and a reader should not have to count rows. */}
                  <td className="px-4 py-2.5 align-top font-mono mg-type-caption tabular-nums text-ink-muted">
                    {i + 1}
                  </td>
                  {/* min-w-0 so a long resolved identity truncates instead of
                      widening the row past the viewport at 375px. */}
                  <td className="px-4 py-2.5 align-top">
                    <div className="min-w-0">
                      <AddressDisplay ss58={entry.coldkey} fallback="—" compact />
                    </div>
                  </td>
                  <td className="px-4 py-2.5 align-top text-right font-mono mg-type-caption tabular-nums whitespace-nowrap text-ink-strong">
                    {fmtAlpha(entry.alpha)}
                  </td>
                  <td className="px-4 py-2.5 align-top text-right">
                    <div className="font-mono mg-type-caption tabular-nums whitespace-nowrap text-ink">
                      {pctStr(entry.share_of_total)}
                    </div>
                    {/* The same bar the mobile list uses, so the concentration
                        this section exists to show is legible at a glance on
                        both breakpoints rather than only the narrow one.
                        aria-hidden: the percentage above it is the value. */}
                    <div
                      aria-hidden
                      className="ml-auto mt-1 h-[3px] w-16 overflow-hidden rounded-full bg-border/60"
                    >
                      <div
                        className="h-full rounded-full bg-accent/70"
                        style={{ width: `${Math.min(100, (entry.share_of_total ?? 0) * 100)}%` }}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-2.5 align-top text-right font-mono mg-type-caption tabular-nums whitespace-nowrap text-ink-muted">
                    {entry.hotkey_count == null ? "—" : formatNumber(entry.hotkey_count)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
