import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { Link } from "@tanstack/react-router";
import { formatNumber } from "@/lib/metagraphed/format";
import type { Block } from "@/lib/metagraphed/types";
import { arrivedBlock, blockActivityEntries } from "./block-activity-window-logic";

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function countLabel(value: number | undefined, noun: string): string {
  if (typeof value !== "number") return `${noun} unavailable`;
  return `${formatNumber(value)} ${noun}${value === 1 ? "" : "s"}`;
}

function activityLevelAttribute(level: number | null): string {
  return level == null ? "unknown" : String(level);
}

/**
 * A dense but inspectable slice of real blocks. It deliberately is not called
 * a time-range heatmap: the current endpoint publishes a bounded result page,
 * not complete historical bins.
 */
export function BlockActivityWindow({
  blocks,
  filtered = false,
}: {
  blocks: readonly Block[];
  /** Labels a page or author-filtered result accurately rather than as latest. */
  filtered?: boolean;
}) {
  const entries = useMemo(() => blockActivityEntries(blocks), [blocks]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const links = useRef<Array<HTMLAnchorElement | null>>([]);
  const touchIntent = useRef<{ key: string; wasSelected: boolean } | null>(null);
  const previousHead = useRef<number | null>(null);
  const previousFiltered = useRef(filtered);
  const [arriving, setArriving] = useState<number | null>(null);
  const active = entries.find((entry) => entry.key === activeKey) ?? entries[0] ?? null;
  const head = entries[0]?.block.block_number ?? null;
  const blockWindowKey = entries.map((entry) => entry.key).join("|");

  // The directory receives a new first page at most once per polling interval.
  // Animate only a confirmed new unfiltered head. A 50-cell two-dimensional
  // grid cannot move every retained mark without temporarily opening gaps at
  // row boundaries, so it repositions atomically and lets the new upper-left
  // mark carry the arrival cue. Changing a filter or returning to page one
  // establishes a fresh baseline instead of pretending that a query change is
  // a chain arrival.
  useBrowserLayoutEffect(() => {
    const filteringChanged = previousFiltered.current !== filtered;
    previousFiltered.current = filtered;
    const nextArrival =
      filteringChanged || filtered ? null : arrivedBlock(previousHead.current, head);
    previousHead.current = head;

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (nextArrival == null || reducedMotion) {
      setArriving(null);
      return undefined;
    }
    setArriving(nextArrival);
    const timeout = window.setTimeout(() => {
      setArriving((current) => (current === nextArrival ? null : current));
    }, 720);
    return () => window.clearTimeout(timeout);
  }, [blockWindowKey, filtered, head]);

  if (!active) return null;

  const activeNumber = formatNumber(active.block.block_number);
  const activeExtrinsics = countLabel(active.block.extrinsic_count, "extrinsic");
  const activeEvents = countLabel(active.block.event_count, "event");
  const title = filtered ? "Current block-result activity" : "Latest indexed block activity";
  const readingId = "block-activity-reading";
  const oldest = entries.at(-1)?.block.block_number;

  const moveFocus = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
    let target: number | null = null;
    if (event.key === "ArrowRight") target = Math.min(entries.length - 1, index + 1);
    if (event.key === "ArrowLeft") target = Math.max(0, index - 1);
    if (event.key === "Home") target = 0;
    if (event.key === "End") target = entries.length - 1;
    if (target == null || target === index) return;
    event.preventDefault();
    const next = entries[target];
    if (!next) return;
    setActiveKey(next.key);
    links.current[target]?.focus();
  };

  // A grid mark has no persistent visual label. On a phone, let the first
  // touch select its exact reading above the grid; a second touch follows the
  // link. Keyboard and assistive-technology activation still open the detail
  // immediately, while pointer hover selects before a desktop click occurs.
  const inspectBeforeNavigate = (
    event: MouseEvent<HTMLAnchorElement>,
    entryKey: string,
    selected: boolean,
  ) => {
    const touch = touchIntent.current;
    touchIntent.current = null;
    // Pointer down occurs before a touch also focuses the link. Keep the
    // selection that was visible at that moment; otherwise focus would make
    // the first touch look like a second activation and navigate away.
    const wasSelected = touch?.key === entryKey ? touch.wasSelected : selected;
    if (event.detail === 0 || wasSelected) return;
    event.preventDefault();
    setActiveKey(entryKey);
  };

  const rememberTouchIntent = (
    event: PointerEvent<HTMLAnchorElement>,
    entryKey: string,
    selected: boolean,
  ) => {
    touchIntent.current =
      event.pointerType === "touch" ? { key: entryKey, wasSelected: selected } : null;
  };

  return (
    <section className="mg-block-activity" aria-labelledby="block-activity-title">
      <header className="mg-block-activity-head">
        <div>
          <p>Block activity</p>
          <h2 id="block-activity-title">{title}</h2>
        </div>
        <p>
          {formatNumber(entries.length)} indexed block{entries.length === 1 ? "" : "s"} · newest
          first
        </p>
      </header>

      <div id={readingId} className="mg-block-activity-reading">
        <span>Inspecting</span>
        <strong>#{activeNumber}</strong>
        <span>{activeExtrinsics}</span>
        <span>{activeEvents}</span>
        <Link
          to="/blocks/$ref"
          params={{ ref: String(active.block.block_number) }}
          preload="intent"
        >
          Open block <span aria-hidden="true">↗</span>
        </Link>
      </div>

      <div className="mg-block-activity-axis" aria-hidden="true">
        <span>Newest</span>
        <span>{oldest == null ? "" : `#${formatNumber(oldest)} oldest`}</span>
      </div>
      <ol
        className="mg-block-activity-grid"
        aria-label={`${title}. Focus a block for its exact counts, then press Enter to open it.`}
      >
        {entries.map((entry, index) => {
          const number = formatNumber(entry.block.block_number);
          const extrinsics = countLabel(entry.block.extrinsic_count, "extrinsic");
          const events = countLabel(entry.block.event_count, "event");
          const selected = entry.key === active.key;
          return (
            <li key={entry.key}>
              <Link
                ref={(element) => {
                  links.current[index] = element;
                }}
                to="/blocks/$ref"
                params={{ ref: String(entry.block.block_number) }}
                preload="intent"
                className="mg-block-activity-mark"
                data-active={selected ? "true" : undefined}
                data-arrived={arriving === entry.block.block_number ? "true" : undefined}
                data-activity-level={activityLevelAttribute(entry.level)}
                tabIndex={selected ? 0 : -1}
                aria-describedby={readingId}
                aria-label={`${selected ? "Open" : "Inspect"} block #${number}: ${extrinsics}, ${events}`}
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") setActiveKey(entry.key);
                }}
                onPointerDown={(event) => rememberTouchIntent(event, entry.key, selected)}
                onFocus={() => setActiveKey(entry.key)}
                onKeyDown={(event) => moveFocus(event, index)}
                onClick={(event) => inspectBeforeNavigate(event, entry.key, selected)}
              >
                <span aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ol>
      <p className="mg-block-activity-note">
        Each mark is one indexed block. Mint intensity is a relative, square-root reading of its
        extrinsic count; the exact count remains above and in the block table. A newly indexed head
        enters at the upper-left; on touch, select a mark to inspect it, then select it again to
        open the block.
      </p>
      <span className="sr-only" aria-live="polite">
        {arriving == null
          ? ""
          : `Block #${formatNumber(arriving)} arrived at the start of the activity window.`}
      </span>
    </section>
  );
}
