import { createFileRoute, notFound } from "@tanstack/react-router";
import { ogImageMeta } from "@/lib/metagraphed/og-card";
import { extrinsicOgContent } from "@/lib/metagraphed/og-entity-content";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, PageHeading } from "@/components/metagraphed/states";
import { shortHash } from "@/lib/metagraphed/blocks";
import { extrinsicCall, isValidExtrinsicHash } from "@/lib/metagraphed/extrinsics";
import { ExtrinsicDetailPage } from "./-extrinsic-detail-page";
import {
  entityNotFoundMeta,
  isMissingEntityError,
  isNotFoundMatch,
} from "@/lib/metagraphed/entity-not-found-meta";
import { rateLimitedResponse } from "@/lib/metagraphed/rate-limited-response";

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
    let result;
    try {
      const { extrinsicQuery } = await import("@/lib/metagraphed/queries");
      result = await context.queryClient.ensureQueryData(extrinsicQuery(params.hash));
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
    // #11204: same second encoding as /blocks/$ref -- the API answers `ok:true`
    // with `extrinsic: null` for a hash it has never seen, so absence arrives
    // as a resolved query rather than an error. `normalizeExtrinsic` folds it
    // to a null `data`.
    if (!result.data) throw notFound();
    return { call: extrinsicCall(result.data.call_module, result.data.call_function) };
  },
  head: ({ params, loaderData, match }) => {
    if (isNotFoundMatch(match)) {
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
        ...ogImageMeta(extrinsicOgContent(params.hash, loaderData?.call)),
      ],
    };
  },
  notFoundComponent: () => (
    <AppShell>
      <PageHeading
        eyebrow="Explorer"
        title="Extrinsic not found"
        description="This reference names no indexed extrinsic."
      />
      {/* #11204: serves both causes now -- malformed, and well-formed but
          naming nothing -- so it no longer asserts the reference was invalid. */}
      <EmptyState
        title="Extrinsic not found"
        description="No indexed extrinsic matches this reference. It may not be indexed yet, or the reference may be malformed — use a 0x-prefixed hexadecimal extrinsic hash or a block#index label (e.g. 123456-2)."
        action={{ label: "Back to extrinsics", href: "/extrinsics" }}
      />
    </AppShell>
  ),
  component: ExtrinsicDetailPage,
});
