import { z } from "zod";
import { RootBasketCaptureSchema } from "./root-basket-capture.ts";
import {
  ROOT_BASKET_READ_LIMITS,
  RootBasketSourceSchema,
  RootBasketPricingSchema,
  RootBasketSummarySchema,
  RootBasketTradingStatusSchema,
} from "./root-basket-runtime.ts";

const capture = RootBasketCaptureSchema.shape;
const fund = capture.funds.element.shape;
const count = capture.expected_funds;

/** Collection contract for the audited modern layout. It deliberately cannot
 * enter the v454 receiver: versioned observations must retain their provenance.
 */
export const RootBasketRuntimeObservationSchema = z
  .object({
    capture_id: capture.capture_id,
    source: RootBasketSourceSchema,
    index: capture.index,
    started_at_ms: capture.started_at_ms,
    finished_at_ms: capture.finished_at_ms,
    pages: capture.pages.min(1).max(ROOT_BASKET_READ_LIMITS.pages),
    funds: z
      .array(
        z
          .object({
            page_index: count,
            pricing: RootBasketPricingSchema,
            summary: RootBasketSummarySchema,
            trading: RootBasketTradingStatusSchema.nullable(),
            baseline: fund.baseline,
          })
          .strict(),
      )
      .max(ROOT_BASKET_READ_LIMITS.funds),
  })
  .strict()
  .superRefine((observation, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (!observation.source.capabilities.pricing) issue("Observation requires runtime pricing");
    const started = capture.started_at_ms.safeParse(observation.started_at_ms);
    const finished = capture.finished_at_ms.safeParse(
      observation.finished_at_ms,
    );
    if (
      started.success &&
      finished.success &&
      BigInt(finished.data) < BigInt(started.data)
    )
      issue("Observation finishes before it starts");
    const seenFunds = new Set<string>();
    const seenCursors = new Set<string>();
    const counts = new Map<number, number>();
    for (const row of observation.funds) {
      if (observation.source.capabilities.trading_status !== (row.trading !== null))
        issue("Trading status must match runtime capability");
      if (
        row.summary.hotkey !== row.pricing.hotkey ||
        seenFunds.has(row.pricing.hotkey)
      )
        issue("Duplicate or mismatched observation fund");
      seenFunds.add(row.pricing.hotkey);
      counts.set(row.page_index, (counts.get(row.page_index) ?? 0) + 1);
      if (
        new Set(row.summary.holdings.map((holding) => holding.netuid)).size !==
        row.summary.holdings.length
      )
        issue("Duplicate observation holding");
    }
    for (const [position, row] of observation.pages.entries()) {
      const start =
        position === 0 ? null : observation.pages[position - 1]!.next_after;
      if (
        row.page_index !== position ||
        row.start_after !== start ||
        (position > 0 && start === null) ||
        (position === observation.pages.length - 1) !==
          (row.next_after === null)
      )
        issue("Observation pages are not a complete contiguous chain");
      if (row.fund_count !== (counts.get(position) ?? 0))
        issue("Observation receipt count mismatch");
      if (row.next_after !== null) {
        if (seenCursors.has(row.next_after))
          issue("Observation cursor repeats");
        seenCursors.add(row.next_after);
      }
    }
    if ([...counts.keys()].some((page) => page >= observation.pages.length))
      issue("Observation fund has no receipt");
  });
