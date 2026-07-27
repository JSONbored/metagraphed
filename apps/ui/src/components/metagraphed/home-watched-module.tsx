import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Panel, HealthPill } from "@jsonbored/ui-kit";
import { useWatchlist } from "@/lib/metagraphed/watchlist";
import {
  economicsQuery,
  subnetHealthMapQuery,
  subnetsQuery,
  validatorsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber, formatTao, classNames } from "@/lib/metagraphed/format";
import type { HealthState } from "@/lib/metagraphed/types";
import { ALL_VALIDATORS_LIMIT } from "@/routes/-validators-index-page";
import {
  accountEventHotkeyIn,
  accountEventNetuidIn,
  useChainStream,
} from "@/hooks/use-chain-stream";

// #8446: brief, subtle background pulse on a watchlist row that just acted
// on-chain -- CSS-transition-based (add the highlight class, then remove it
// after this window so the row's own `transition-colors` fades it back out),
// not a JS-animated loop, per the epic's own liveness guardrail.
const FLASH_DURATION_MS = 1600;

/** Shared row-flash state: which ids are currently highlighted. */
function useRowFlash() {
  const [flashed, setFlashed] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);
  const flash = (id: string) => {
    setFlashed((prev) => new Set(prev).add(id));
    const existing = timers.current.get(id);
    if (existing) clearTimeout(existing);
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setFlashed((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, FLASH_DURATION_MS),
    );
  };
  return { flashed, flash };
}

// The watchlist is the only personalization the site has, and it lives entirely
// in localStorage -- so this module cannot be server-rendered, and it must not
// claim "nothing watched" before the effect that reads storage has run. Both
// `useWatchlist` hooks return an empty set on the first client render; the
// module renders its nudge only once we know the sets really are empty, which
// is indistinguishable here from the pre-hydration state. Rendering the nudge
// in both cases is correct: it's the same content either way, and it never
// flashes wrong data.

const MAX_ROWS = 6;

/**
 * Home's "Watched" module (#8256). Shows the price/emission/health of watched
 * subnets and the stake/APY of watched validators, so the stars someone set on
 * the index pages pay off on the page they land on.
 *
 * Returns null when nothing is watched *and* the caller asked to stay quiet --
 * the empty state is a one-line nudge, not a framed panel, because an empty
 * module that explains itself at full size is exactly the "No X yet" furniture
 * #8255 bans.
 */
export function HomeWatchedModule() {
  const subnetWatch = useWatchlist("subnet");
  const validatorWatch = useWatchlist("validator");
  const watchedSubnets = [...subnetWatch.ids];
  const watchedValidators = [...validatorWatch.ids];
  const nothingWatched = watchedSubnets.length === 0 && watchedValidators.length === 0;

  if (nothingWatched) {
    return (
      <p className="mg-type-caption text-ink-muted">
        Star a subnet on{" "}
        <Link to="/subnets" className="text-accent-text hover:underline">
          the registry
        </Link>{" "}
        or a validator on{" "}
        <Link to="/validators" className="text-accent-text hover:underline">
          the validators list
        </Link>{" "}
        and it shows up here with its latest price, emission and health. Stars live in this browser
        — no account needed.
      </p>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {watchedSubnets.length > 0 ? <WatchedSubnets netuids={watchedSubnets} /> : null}
      {watchedValidators.length > 0 ? <WatchedValidators hotkeys={watchedValidators} /> : null}
    </div>
  );
}

function WatchedSubnets({ netuids }: { netuids: string[] }) {
  // Both lists are already fetched elsewhere on the homepage, so these resolve
  // from cache rather than costing a request.
  const subnets = useQuery(subnetsQuery()).data?.data ?? [];
  const econ = useQuery(economicsQuery()).data?.data ?? [];
  const econByNetuid = new Map(econ.map((e) => [e.netuid, e]));
  // Health is NOT on the subnets list row -- /subnets joins it from a separate
  // map query, and without that join every row here rendered a misleading
  // "Unknown" pill. Same query, so it's a shared cache hit.
  const healthMap = useQuery(subnetHealthMapQuery()).data?.data ?? {};
  const watched = new Set(netuids);

  const { flashed, flash } = useRowFlash();
  useChainStream({
    topics: ["account_events"],
    matches: (payload) => accountEventNetuidIn(payload, watched),
    onEvent: (payload) => {
      const netuid = (payload as { netuid?: unknown }).netuid;
      if (netuid != null) flash(String(netuid));
    },
  });

  const rows = subnets.filter((s) => watched.has(String(s.netuid))).slice(0, MAX_ROWS);
  // A star can outlive the subnet it points at (deregistration, or a stale
  // localStorage entry from another environment). Say so rather than silently
  // showing fewer rows than the user starred.
  const missing = netuids.length - rows.length;

  return (
    <Panel as="section" title={`Watched subnets · ${netuids.length}`}>
      <ul className="divide-y divide-border">
        {rows.map((s) => {
          const e = econByNetuid.get(s.netuid);
          const health = healthMap[s.netuid]?.health as HealthState | undefined;
          return (
            <li
              key={s.netuid}
              className={classNames(
                "transition-colors duration-1000",
                flashed.has(String(s.netuid)) && "bg-accent/15",
              )}
            >
              <Link
                to="/subnets/$netuid"
                params={{ netuid: s.netuid }}
                className="flex items-center gap-3 py-2 hover:bg-surface/50"
              >
                <Star className="size-3 shrink-0 fill-accent text-accent" aria-hidden />
                <span className="min-w-0 flex-1 truncate mg-type-data text-ink-strong">
                  {s.name ?? `SN${s.netuid}`}
                </span>
                <span className="shrink-0 tabular-nums mg-type-data-sm text-ink-muted">
                  {e?.alpha_price_tao != null ? `${e.alpha_price_tao.toFixed(4)} τ` : "—"}
                </span>
                <span className="shrink-0 tabular-nums mg-type-data-sm text-ink-muted">
                  {e?.emission_share != null ? `${(e.emission_share * 100).toFixed(2)}%` : "—"}
                </span>
                {health ? <HealthPill state={health} /> : <span className="w-4" aria-hidden />}
              </Link>
            </li>
          );
        })}
      </ul>
      <Footnote shown={rows.length} total={netuids.length} missing={missing} noun="subnet" />
    </Panel>
  );
}

function WatchedValidators({ hotkeys }: { hotkeys: string[] }) {
  // Same sort + limit as the /validators index, so this shares that query's
  // cache key instead of firing a second 2000-row fetch.
  const validators =
    useQuery(validatorsQuery({ sort: "total_stake", limit: ALL_VALIDATORS_LIMIT })).data?.data
      ?.validators ?? [];
  const watched = new Set(hotkeys);

  const { flashed, flash } = useRowFlash();
  useChainStream({
    topics: ["account_events"],
    matches: (payload) => accountEventHotkeyIn(payload, watched),
    onEvent: (payload) => {
      const hotkey = (payload as { hotkey?: unknown }).hotkey;
      if (typeof hotkey === "string") flash(hotkey);
    },
  });

  const rows = validators.filter((v) => watched.has(v.hotkey)).slice(0, MAX_ROWS);
  const missing = hotkeys.length - rows.length;

  return (
    <Panel as="section" title={`Watched validators · ${hotkeys.length}`}>
      <ul className="divide-y divide-border">
        {rows.map((v) => (
          <li
            key={v.hotkey}
            className={classNames(
              "transition-colors duration-1000",
              flashed.has(v.hotkey) && "bg-accent/15",
            )}
          >
            <Link
              to="/validators/$hotkey"
              params={{ hotkey: v.hotkey }}
              className="flex items-center gap-3 py-2 hover:bg-surface/50"
            >
              <Star className="size-3 shrink-0 fill-accent text-accent" aria-hidden />
              <span className="min-w-0 flex-1 truncate mg-type-data text-ink-strong">
                {v.coldkey_identity?.name ?? `${v.hotkey.slice(0, 6)}…${v.hotkey.slice(-6)}`}
              </span>
              <span className="shrink-0 tabular-nums mg-type-data-sm text-ink-muted">
                {formatTao(v.total_stake_tao)}
              </span>
              <span className="shrink-0 tabular-nums mg-type-data-sm text-ink-muted">
                {v.apy_estimate != null ? `${(v.apy_estimate * 100).toFixed(2)}%` : "—"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <Footnote shown={rows.length} total={hotkeys.length} missing={missing} noun="validator" />
    </Panel>
  );
}

function Footnote({
  shown,
  total,
  missing,
  noun,
}: {
  shown: number;
  total: number;
  missing: number;
  noun: string;
}) {
  const overflow = total - shown - missing;
  if (overflow <= 0 && missing <= 0) return null;
  return (
    <p className="pt-2 mg-type-caption text-ink-muted">
      {overflow > 0 ? `+${formatNumber(overflow)} more watched. ` : ""}
      {missing > 0
        ? `${formatNumber(missing)} watched ${noun}${missing === 1 ? "" : "s"} ${missing === 1 ? "isn't" : "aren't"} in the current index.`
        : ""}
    </p>
  );
}
