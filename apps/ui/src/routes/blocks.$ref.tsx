import { createFileRoute, notFound } from "@tanstack/react-router";
import { ogImageMeta } from "@/lib/metagraphed/og-card";
import { blockOgContent } from "@/lib/metagraphed/og-entity-content";
import { AppShell } from "@/components/metagraphed/app-shell";
import { BlockDetailLoadingSkeleton } from "@/components/metagraphed/route-loading-skeleton";
import { EmptyState, PageHeading } from "@/components/metagraphed/states";
import { isValidBlockRef } from "@/lib/metagraphed/blocks";
import { startBlockRouteQueries } from "@/lib/metagraphed/block-route-loader";
import { BlockDetailPage } from "./-block-detail-page";
import {
  entityNotFoundMeta,
  isMissingEntityError,
  isNotFoundMatch,
} from "@/lib/metagraphed/entity-not-found-meta";
import { rateLimitedResponse } from "@/lib/metagraphed/rate-limited-response";

export const Route = createFileRoute("/blocks/$ref")({
  // #3422: validate the ref at the router level so an invalid one renders the
  // real not-found boundary (notFoundComponent) instead of an in-page early
  // return. parseParams runs before the loader, so downstream code only ever
  // sees a well-formed ref.
  parseParams: ({ ref }) => {
    if (!isValidBlockRef(ref)) throw notFound();
    return { ref };
  },
  // Prime the shared cache so head() can title the page with the real block
  // number. Non-fatal: any failure falls back to the ref-only copy and the
  // page's own useSuspenseQuery still drives the not-found/empty path.
  loader: async ({ context, params }) => {
    let result;
    const pending = await startBlockRouteQueries(context.queryClient, params.ref);
    try {
      result = await pending.block;
    } catch (error) {
      // #11000: a throttled PRIMARY query has no page to render, and answering
      // 200-with-an-error-card tells a crawler the render succeeded. Throw the
      // 429 + Retry-After instead, which is the signal that makes it back off
      // and keep the URL. Panel-level 429s inside an otherwise-good page are
      // untouched and still render states.tsx's in-place notice.
      const throttled = rateLimitedResponse(error);
      if (throttled) throw throttled;
      // #8624: only a 404 from our own API means "no such entity". Any other
      // failure keeps returning null so the page still renders and the
      // component's own query drives the error path -- marking a page noindex
      // on a transient blip would de-index real entities during an outage.
      if (isMissingEntityError(error)) throw notFound();
      return null;
    }
    // #11204: absence has a SECOND encoding on this route, and it was the one
    // that actually shipped. /api/v1/blocks/999999999999 answers `ok:true` with
    // `block: null` (it carries prev/next block numbers alongside), so nothing
    // ever threw, `isMissingEntityError` never fired, and the page rendered 200
    // under the confident title "Block 999999999999". `normalizeBlock` folds
    // that envelope to a null `data`, which is the unambiguous absence signal.
    if (!result.data) throw notFound();
    // On client navigation the ledger keeps resolving in the shared query
    // cache while the route renders as soon as its authoritative header is
    // known. Direct server renders deliberately stay progressive: dehydrating
    // a secondary table bloats HTML and hides its truthful catch-up state.
    void pending.extrinsics;
    return { blockNumber: result.data.block_number ?? null };
  },
  head: ({ params, loaderData, match }) => {
    if (isNotFoundMatch(match)) {
      return entityNotFoundMeta("Block", "No indexed Bittensor block matches this number or hash.");
    }
    const label = loaderData?.blockNumber != null ? `#${loaderData.blockNumber}` : params.ref;
    const title = `Block ${label} — Metagraphed`;
    const description = `Bittensor block ${label}: hash, parent, author, extrinsic and event counts, indexed from the chain on Metagraphed.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        ...ogImageMeta(blockOgContent(params.ref, loaderData?.blockNumber)),
      ],
    };
  },
  pendingComponent: BlockDetailLoadingSkeleton,
  notFoundComponent: () => (
    <AppShell>
      <PageHeading
        eyebrow="Explorer"
        title="Block not found"
        description="This reference names no indexed block."
      />
      {/* #11204: the boundary now serves BOTH causes -- a malformed reference
          and a well-formed one that names nothing -- so the copy names both
          rather than asserting the reference was invalid. */}
      <EmptyState
        title="Block not found"
        description="No indexed block matches this reference. It may not be indexed yet, or the reference may be malformed — use a decimal block number or a 0x-prefixed hexadecimal block hash."
        action={{ label: "Back to blocks", href: "/blocks" }}
      />
    </AppShell>
  ),
  component: BlockDetailPage,
});
