// Collection only: no persistence, publication, RPC endpoint, or scheduler.
// All RPC work is supplied by the caller and pinned to one finalized source.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ROOT_BASKET_READ_LIMITS,
  RootBasketRuntimeObservationSchema,
  RootBasketSourceSchema,
} from "../schemas-src/root-basket-runtime.ts";
import {
  openRootBasketRuntime,
  type BasketRpc,
} from "./root-basket-runtime.ts";

export async function collectRootBasketObservation(
  rpc: BasketRpc,
  network: z.infer<typeof RootBasketSourceSchema>["network"],
  asOf?: string,
) {
  const started = Date.now().toString();
  const runtime = await openRootBasketRuntime(rpc, network, asOf);
  const index = await runtime.indexSnapshot();
  if (
    index.completed_block !== null &&
    BigInt(index.completed_block) > BigInt(runtime.source.finalized_block)
  )
    throw new Error("Basket index completion exceeds finalized source");
  const funds: z.infer<typeof RootBasketRuntimeObservationSchema>["funds"] = [];
  const pages: z.infer<typeof RootBasketRuntimeObservationSchema>["pages"] = [];
  const seenFunds = new Set<string>();
  const seenCursors = new Set<string>();
  let start: string | null = null;
  for (;;) {
    if (pages.length === ROOT_BASKET_READ_LIMITS.pages)
      throw new Error("Basket observation exceeds page budget");
    const page = await runtime.pricingPage(start);
    if (funds.length + page.pricing.length > ROOT_BASKET_READ_LIMITS.funds)
      throw new Error("Basket observation exceeds fund budget");
    if (page.next_after !== null) {
      if (seenCursors.has(page.next_after))
        throw new Error("Basket observation cursor repeats");
      seenCursors.add(page.next_after);
    }
    const pageIndex = pages.length;
    pages.push({
      page_index: pageIndex,
      start_after: start,
      next_after: page.next_after,
      response_sha256: page.response_sha256,
      fund_count: page.pricing.length,
    });
    for (const pricing of page.pricing) {
      if (seenFunds.has(pricing.hotkey))
        throw new Error("Duplicate basket observation fund");
      seenFunds.add(pricing.hotkey);
      const [summary, trading, baseline] = await Promise.all([
        runtime.summary(pricing.hotkey),
        runtime.tradingStatus(pricing.hotkey),
        runtime.baseline(pricing.hotkey),
      ]);
      funds.push({
        page_index: pageIndex,
        pricing,
        summary,
        trading,
        baseline,
      });
    }
    // Empty pages can be nonterminal: upstream caps visited storage rows as
    // well as live funds. Only the explicit cursor marks completion.
    if (page.next_after === null) break;
    start = page.next_after;
  }
  return RootBasketRuntimeObservationSchema.parse({
    capture_id: randomUUID(),
    source: runtime.source,
    index,
    started_at_ms: started,
    finished_at_ms: Date.now().toString(),
    pages,
    funds,
  });
}
