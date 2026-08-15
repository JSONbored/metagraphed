import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Star, Clock, Rss, Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Panel, HealthPill, ExternalLink } from "@jsonbored/ui-kit";
import { useWatchlist } from "@/lib/metagraphed/watchlist";
import { useApiBase } from "@/hooks/use-api-base";
import { useCopy } from "@/hooks/use-copy";
import {
  encodeWatchFeedIds,
  buildWatchFeedUrl,
  WATCH_FEED_FORMATS,
} from "@/lib/metagraphed/watch-feed";
import { useSwCacheAge } from "@/hooks/use-sw-cache-age";
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

/**
 * #8367: kill switch for the watchlist row pulse, independent of the header
 * block ticker's own flag, so either liveness cue can be rolled back without
 * touching the other.
 */
const WATCHLIST_ROW_FLASH_ENABLED = true;

// #8446: brief, subtle background pulse on a watchlist row that just acted
// on-chain. #8367 moved the actual animation into ui-kit's `.mg-row-flash`
// rather than the Tailwind `transition-colors duration-1000` + `bg-accent/15`
// pair this used to carry inline: those utilities sit outside every
// `prefers-reduced-motion` block in the codebase (which all name specific
// `mg-*` classes -- there is no universal reset), so the pulse played
// regardless of the visitor's motion preference. As a named class it's
// covered by the same media query as `.mg-flash-up`/`.mg-pulse`.
//
// This still gates the highlight's LIFETIME in JS, because the set drives the
// `key` that replays the animation; the animation duration itself lives in
// the stylesheet and the two are kept in step deliberately.
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
    if (!WATCHLIST_ROW_FLASH_ENABLED) return;
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
  // #8384 requirement (c): a proxy for "how fresh is the data behind this
  // whole module" -- /api/v1/subnets is one of several SWR-cached endpoints
  // it reads (see public/sw.js's SWR_API_PATTERN), used here as a single
  // representative signal rather than tracking each query's own cache entry
  // separately, which would be more precise but also considerably noisier
  // to show as one line of UI.
  const cachedAgeMs = useSwCacheAge("/api/v1/subnets");

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
    <div className="space-y-2">
      {cachedAgeMs != null ? (
        <p className="inline-flex items-center gap-1.5 mg-type-caption-sm text-ink-muted">
          <Clock className="size-3 shrink-0" aria-hidden />
          cached · {Math.round(cachedAgeMs / 60_000)}m old
        </p>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        {watchedSubnets.length > 0 ? <WatchedSubnets netuids={watchedSubnets} /> : null}
        {watchedValidators.length > 0 ? <WatchedValidators hotkeys={watchedValidators} /> : null}
      </div>
      <WatchFeedSubscribe subnetIds={watchedSubnets} validatorIds={watchedValidators} />
    </div>
  );
}

/**
 * #8526: "Subscribe to this watchlist" affordance — the UI half of the #8376
 * per-watchlist feed endpoint (GET /api/v1/feeds/watch?ids=). Mirrors the
 * per-subnet WatchEntitySheet's format list + the registry-feed RSS affordance:
 * the current watchlist re-encoded straight into the URL (local-first, no server
 * round-trip), offered as RSS / Atom / JSON with a copy button. Only rendered
 * from HomeWatchedModule's non-empty branch, so there is never an empty `ids=`.
 */
function WatchFeedSubscribe({
  subnetIds,
  validatorIds,
}: {
  subnetIds: string[];
  validatorIds: string[];
}) {
  const { base } = useApiBase();
  const { copied, copy } = useCopy({ label: "watchlist feed url" });
  const encoded = encodeWatchFeedIds({ subnet: subnetIds, validator: validatorIds });
  // Defensive: HomeWatchedModule only renders this in its non-empty branch, but
  // keep the guard so the component is safe to render anywhere.
  if (!encoded) return null;
  const rssUrl = buildWatchFeedUrl(base, encoded, ".rss");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border pt-2 mg-type-caption text-ink-muted">
      <span className="inline-flex items-center gap-1.5">
        <Rss className="size-3 shrink-0 text-accent" aria-hidden />
        Subscribe to this watchlist
      </span>
      <span className="inline-flex flex-wrap items-center gap-2">
        {WATCH_FEED_FORMATS.map((fmt) => {
          const href = buildWatchFeedUrl(base, encoded, fmt.suffix);
          return href ? (
            <ExternalLink key={fmt.suffix} href={href} className="text-accent-text hover:underline">
              {fmt.label}
            </ExternalLink>
          ) : null;
        })}
        {rssUrl ? (
          <button
            type="button"
            onClick={() => copy(rssUrl)}
            aria-label="Copy watchlist RSS feed URL"
            className="mg-focus-ring inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-muted transition-colors hover:bg-surface hover:text-ink-strong"
          >
            {copied ? (
              <Check className="size-3 text-health-ok" aria-hidden />
            ) : (
              <Copy className="size-3" aria-hidden />
            )}
            {copied ? "Copied" : "Copy URL"}
          </button>
        ) : null}
      </span>
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
  // #8367's per-event cost budget. The cross-reference an incoming firehose
  // event pays is one `Set.prototype.has` (see `accountEventNetuidIn`), which
  // is O(1) in the number of watched subnets -- NOT a scan of `netuids`, and
  // NOT proportional to how many rows are on screen. The set is rebuilt per
  // render rather than memoized on purpose: it is O(watched) over a list the
  // watchlist UI caps well below a hundred, so building it costs less than the
  // dependency-array bookkeeping memoizing it would add, and a stale set would
  // silently stop flashing a just-starred subnet.
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
              className={classNames(flashed.has(String(s.netuid)) && "mg-row-flash")}
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
          <li key={v.hotkey} className={classNames(flashed.has(v.hotkey) && "mg-row-flash")}>
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
