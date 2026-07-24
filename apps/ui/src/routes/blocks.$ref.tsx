import { createFileRoute, notFound } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, PageHeading } from "@/components/metagraphed/states";
import { blockQuery } from "@/lib/metagraphed/queries";
import { isValidBlockRef } from "@/lib/metagraphed/blocks";
import { BlockDetailPage } from "./-blocks-ref-page";

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
    try {
      const { data } = await context.queryClient.ensureQueryData(blockQuery(params.ref));
      return { blockNumber: data?.block_number ?? null };
    } catch {
      return null;
    }
  },
  head: ({ params, loaderData }) => {
    const label = loaderData?.blockNumber != null ? `#${loaderData.blockNumber}` : params.ref;
    const title = `Block ${label} — Metagraphed`;
    const description = `Bittensor block ${label}: hash, parent, author, extrinsic and event counts, indexed from the chain on Metagraphed.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
      ],
    };
  },
  notFoundComponent: () => (
    <AppShell>
      <PageHeading
        eyebrow="Explorer"
        title="Block not found"
        description="Block references must be a decimal block number or a 0x-prefixed hex hash."
      />
      <EmptyState
        title="Invalid block reference"
        description="Use a decimal block number or a 0x-prefixed hexadecimal block hash."
        action={{ label: "Back to blocks", href: "/blocks" }}
      />
    </AppShell>
  ),
  component: BlockDetailPage,
});
