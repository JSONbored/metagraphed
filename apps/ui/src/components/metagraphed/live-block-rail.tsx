import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { TimeAgo } from "@jsonbored/ui-kit";
import { formatNumber } from "@/lib/metagraphed/format";
import { blockExtrinsicsInfiniteQuery } from "@/lib/metagraphed/queries";
import type { Block } from "@/lib/metagraphed/types";
import { arrivedBlock } from "./chain-stream/block-activity-window-logic";

/** A compact, inspectable live window—not an endlessly moving ticker. */
export const LIVE_BLOCK_LIMIT = 12;

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function blockKey(block: Block): string {
  return block.block_hash || String(block.block_number);
}

/**
 * The endpoint is documented newest-first. Keep that order explicit at the
 * display boundary so a stale cache or an alternate source cannot reverse the
 * live reading; a new head always enters from the left.
 */
export function visibleBlocks(blocks: readonly Block[], limit = LIVE_BLOCK_LIMIT): Block[] {
  return [...blocks]
    .sort((left, right) => right.block_number - left.block_number)
    .slice(0, Math.max(0, limit));
}

/** A supplemental relative mark; exact counts remain visible in each tile. */
export function blockActivityRatio(
  extrinsicCount: number | null | undefined,
  highestCount: number,
): number {
  if (
    typeof extrinsicCount !== "number" ||
    !Number.isFinite(extrinsicCount) ||
    !Number.isFinite(highestCount) ||
    extrinsicCount <= 0 ||
    highestCount <= 0
  ) {
    return 0;
  }
  return Math.min(1, extrinsicCount / highestCount);
}

function countLabel(value: number | null | undefined, noun: string): string {
  if (typeof value !== "number") return `${noun} unavailable`;
  return `${formatNumber(value)} ${noun}${value === 1 ? "" : "s"}`;
}

export function LiveBlockRail({
  blocks,
  loading = false,
  error = false,
  updatedAt = null,
  compact = false,
}: {
  blocks: readonly Block[];
  loading?: boolean;
  error?: boolean;
  updatedAt?: string | null;
  /** Integrates the live window into an existing analytical hero. */
  compact?: boolean;
}) {
  const latest = useMemo(() => visibleBlocks(blocks), [blocks]);
  const highestCount = useMemo(
    () => Math.max(0, ...latest.map((block) => block.extrinsic_count ?? 0)),
    [latest],
  );
  const head = latest[0]?.block_number ?? null;
  const previousHead = useRef<number | null>(null);
  const previousRects = useRef(new Map<string, DOMRect>());
  const itemElements = useRef(new Map<string, HTMLAnchorElement>());
  const intentTimer = useRef<number | null>(null);
  const [arriving, setArriving] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const blockWindowKey = latest.map(blockKey).join("|");

  // A block reached through this rail is an intentional reading path. The
  // router's intent preloader warms its compact identity record; this
  // component warms the extrinsic ledger, its first document section. Both
  // wait for a short sustained hover/focus instead of fetching every tile the
  // pointer happens to cross. That preserves the rail's calm live-update
  // budget while hiding the relevant reads behind the reader's intent.
  const clearIntent = useCallback(() => {
    if (intentTimer.current == null) return;
    window.clearTimeout(intentTimer.current);
    intentTimer.current = null;
  }, []);
  const warmExtrinsics = useCallback(
    (blockNumber: number) => {
      void queryClient.prefetchInfiniteQuery({
        ...blockExtrinsicsInfiniteQuery(String(blockNumber), 100),
        retry: 0,
      });
    },
    [queryClient],
  );
  const beginIntent = useCallback(
    (blockNumber: number) => {
      clearIntent();
      intentTimer.current = window.setTimeout(() => {
        intentTimer.current = null;
        warmExtrinsics(blockNumber);
      }, 140);
    },
    [clearIntent, warmExtrinsics],
  );

  useEffect(() => clearIntent, [clearIntent]);

  // The first successful feed establishes the baseline. On a genuine new
  // head, retained tiles animate from their previous position to the right;
  // the new tile enters at the left. This is a bounded, reader-owned update,
  // not a continuously moving ticker.
  useBrowserLayoutEffect(() => {
    const nextRects = new Map<string, DOMRect>();
    for (const [key, element] of itemElements.current) {
      nextRects.set(key, element.getBoundingClientRect());
    }

    const nextArrival = arrivedBlock(previousHead.current, head);
    previousHead.current = head;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    if (nextArrival !== null && !reducedMotion) {
      for (const [key, nextRect] of nextRects) {
        const previousRect = previousRects.current.get(key);
        const element = itemElements.current.get(key);
        if (!previousRect || !element) continue;
        const deltaX = previousRect.left - nextRect.left;
        if (Math.abs(deltaX) < 1) continue;
        element.animate(
          [{ transform: `translateX(${deltaX}px)` }, { transform: "translateX(0)" }],
          { duration: 260, easing: "cubic-bezier(0.2, 0.7, 0, 1)" },
        );
      }
    }
    previousRects.current = nextRects;

    if (nextArrival == null) return undefined;
    setArriving(nextArrival);
    const timeout = window.setTimeout(() => {
      setArriving((current) => (current === nextArrival ? null : current));
    }, 720);
    return () => window.clearTimeout(timeout);
  }, [blockWindowKey, head]);

  const indexedAt = updatedAt ?? latest[0]?.observed_at ?? null;

  return (
    <section
      className={compact ? "mg-live-blocks mg-live-blocks--hero" : "mg-live-blocks"}
      aria-labelledby="live-blocks-title"
    >
      <div className="mg-live-blocks-head">
        <div>
          <p className="mg-live-blocks-kicker">{compact ? "Live explorer" : "Block explorer"}</p>
          <h2 id="live-blocks-title">{compact ? "Latest blocks." : "Latest indexed blocks."}</h2>
        </div>
        <p className="mg-live-blocks-status">
          {error && latest.length > 0 ? (
            "Showing the last indexed result; the latest refresh did not complete."
          ) : indexedAt ? (
            <>
              {latest.length}-block window · newest at left · indexed <TimeAgo at={indexedAt} />.
            </>
          ) : (
            "Newest at left. Refreshes while this tab is open."
          )}
        </p>
      </div>

      {latest.length > 0 ? (
        <div
          className="mg-live-blocks-viewport"
          aria-label="Latest indexed blocks, newest at left. Scroll or swipe to inspect all blocks."
          tabIndex={0}
        >
          <ol className="mg-live-blocks-list">
            {latest.map((block) => {
              const activity = blockActivityRatio(block.extrinsic_count, highestCount);
              const number = formatNumber(block.block_number);
              const extrinsics = countLabel(block.extrinsic_count, "extrinsic");
              const events = countLabel(block.event_count, "event");
              const key = blockKey(block);
              return (
                <li key={key}>
                  <Link
                    to="/blocks/$ref"
                    params={{ ref: String(block.block_number) }}
                    preload="intent"
                    preloadDelay={140}
                    onPointerEnter={(event) => {
                      if (event.pointerType === "mouse") beginIntent(block.block_number);
                    }}
                    onPointerLeave={clearIntent}
                    onFocus={() => beginIntent(block.block_number)}
                    onBlur={clearIntent}
                    className="mg-live-block"
                    data-arrived={arriving === block.block_number ? "true" : undefined}
                    ref={(element) => {
                      if (element) itemElements.current.set(key, element);
                      else itemElements.current.delete(key);
                    }}
                    aria-label={`Open block #${number}: ${extrinsics}, ${events}`}
                  >
                    <span className="mg-live-block-label">Block</span>
                    <span className="mg-live-block-open" aria-hidden="true">
                      ↗
                    </span>
                    <strong>#{number}</strong>
                    <span className="mg-live-block-counts">
                      <span>{extrinsics}</span>
                      <span>{events}</span>
                    </span>
                    <span className="mg-live-block-activity" aria-hidden="true">
                      <span
                        style={
                          { "--mg-live-block-activity": `${activity * 100}%` } as CSSProperties
                        }
                      />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </div>
      ) : loading ? (
        <div
          className="mg-live-blocks-viewport"
          aria-busy="true"
          aria-label="Loading latest blocks"
        >
          <ol className="mg-live-blocks-list" aria-hidden="true">
            {Array.from({ length: 4 }, (_, index) => (
              <li key={index} className="mg-live-block mg-live-block--loading">
                <span />
                <span />
                <span />
              </li>
            ))}
          </ol>
        </div>
      ) : error ? (
        <p className="mg-live-blocks-empty">
          Latest indexed blocks could not be read.{" "}
          <Link to="/chain/blocks">Open the block stream.</Link>
        </p>
      ) : (
        <p className="mg-live-blocks-empty">
          No indexed blocks are available yet.{" "}
          <Link to="/chain/blocks">Open the block stream.</Link>
        </p>
      )}
      <span className="sr-only" aria-live="polite">
        {arriving == null
          ? ""
          : `Block #${formatNumber(arriving)} arrived at the start of the window.`}
      </span>
    </section>
  );
}
