import { createFileRoute, notFound } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, PageHeading } from "@/components/metagraphed/states";
import { extrinsicQuery } from "@/lib/metagraphed/queries";
import { shortHash } from "@/lib/metagraphed/blocks";
import { extrinsicCall, isValidExtrinsicHash } from "@/lib/metagraphed/extrinsics";
import { ExtrinsicDetailPage } from "./-extrinsics-hash-page";
import { entityNotFoundMeta, isMissingEntityError } from "@/lib/metagraphed/entity-not-found-meta";

export const Route = createFileRoute("/extrinsics/$hash")({
  // #3422: validate the hash at the router level so an invalid one renders the
  // real not-found boundary (notFoundComponent) instead of an in-page early
  // return. parseParams runs before the loader, so downstream code only ever
  // sees a well-formed hash.
  parseParams: ({ hash }) => {
    if (!isValidExtrinsicHash(hash)) throw notFound();
    return { hash };
  },
  // Prime the shared cache so head() can title with the call name. Non-fatal:
  // any failure falls back to the hash-only copy and the page's own
  // useSuspenseQuery still drives the not-found/empty path.
  loader: async ({ context, params }) => {
    try {
      const { data } = await context.queryClient.ensureQueryData(extrinsicQuery(params.hash));
      return {
        call: data ? extrinsicCall(data.call_module, data.call_function) : null,
      };
    } catch (error) {
      // #8624: only a 404 from our own API means "no such entity". Any other
      // failure keeps returning null so the page still renders and the
      // component's own query drives the error path -- marking a page noindex
      // on a transient blip would de-index real entities during an outage.
      if (isMissingEntityError(error)) return { missing: true as const };
      return null;
    }
  },
  head: ({ params, loaderData }) => {
    if (loaderData && "missing" in loaderData) {
      return entityNotFoundMeta(
        "Extrinsic",
        "No indexed Bittensor extrinsic matches this reference.",
      );
    }
    const label = shortHash(params.hash) ?? params.hash;
    const call = loaderData?.call && loaderData.call !== "—" ? ` (${loaderData.call})` : "";
    const title = `Extrinsic ${label}${call} — Metagraphed`;
    const description = `Bittensor extrinsic ${label}: block, call, signer, and result, indexed from the chain on Metagraphed.`;
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
        title="Extrinsic not found"
        description="Extrinsic references must be a 0x-prefixed hexadecimal hash or a block#index label (e.g. 123456-2)."
      />
      <EmptyState
        title="Invalid extrinsic reference"
        description="Use a 0x-prefixed hexadecimal extrinsic hash or a block#index label (e.g. 123456-2)."
        action={{ label: "Back to extrinsics", href: "/extrinsics" }}
      />
    </AppShell>
  ),
  component: ExtrinsicDetailPage,
});
