import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, type ReactNode } from "react";
import { Boxes, FileText, Zap } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { PageHero } from "@/components/metagraphed/page-hero";
import { SectionAnchor } from "@/components/metagraphed/section-anchor";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { blockQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { blockRefPathSegment, isValidBlockRef, shortHash } from "@/lib/metagraphed/blocks";

export const Route = createFileRoute("/blocks/$ref")({
  // Prime the shared cache so head() can title the page with the real block
  // number. Non-fatal: any failure falls back to the ref-only copy and the
  // page's own useSuspenseQuery still drives the not-found/empty path.
  loader: async ({ context, params }) => {
    if (!isValidBlockRef(params.ref)) {
      return null;
    }

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
  component: BlockDetailPage,
});

function BlockDetailPage() {
  const { ref } = Route.useParams();
  return (
    <AppShell>
      <QueryErrorBoundary>
        <Suspense fallback={<DetailSkeleton />}>
          <BlockDetail refValue={ref} />
        </Suspense>
      </QueryErrorBoundary>
    </AppShell>
  );
}

function BlockDetail({ refValue }: { refValue: string }) {
  if (!isValidBlockRef(refValue)) {
    return (
      <>
        <PageHeading
          eyebrow="Explorer"
          title="Invalid block reference"
          description="Block references must be a decimal block number or a 0x-prefixed hex hash."
        />
        <EmptyState
          title="Invalid block reference"
          description="Use a decimal block number or a 0x-prefixed hexadecimal block hash."
          action={{ label: "Back to blocks", href: "/blocks" }}
        />
      </>
    );
  }

  return <ValidBlockDetail refValue={refValue} />;
}

function ValidBlockDetail({ refValue }: { refValue: string }) {
  const sourceRef = blockRefPathSegment(refValue);
  const block = useSuspenseQuery(blockQuery(refValue)).data.data;

  if (!block) {
    return (
      <>
        <PageHeading
          eyebrow="Explorer"
          title={`Block ${refValue}`}
          description="This block isn't indexed yet."
        />
        <EmptyState
          title="Block not found or not yet indexed"
          description="The chain poller indexes recent blocks every few minutes. Cold or out-of-range blocks aren't available."
          action={{ label: "Back to blocks", href: "/blocks" }}
        />
        <ApiSourceFooter
          paths={[`/api/v1/blocks/${sourceRef}`]}
          artifacts={[`/metagraph/blocks/${sourceRef}.json`]}
        />
      </>
    );
  }

  return (
    <>
      <PageHero
        eyebrow="Explorer · block"
        live
        title={`#${formatNumber(block.block_number)}`}
        description={<span className="font-mono text-sm break-all">{block.block_hash || "—"}</span>}
        caption="explorer / v1"
      />

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8">
        <StatTile
          icon={FileText}
          eyebrow="Extrinsics"
          value={formatNumber(block.extrinsic_count ?? 0)}
        />
        <StatTile icon={Zap} eyebrow="Events" value={formatNumber(block.event_count ?? 0)} />
        <StatTile
          icon={Boxes}
          eyebrow="Observed"
          value={<TimeAgo at={block.observed_at} />}
          tone="accent"
        />
      </div>

      <SectionAnchor id="details" title="Block details" tone="accent">
        <dl className="rounded border border-border bg-card divide-y divide-border">
          <FieldRow label="Block number">
            <span className="font-mono text-sm text-ink-strong tabular-nums">
              {formatNumber(block.block_number)}
            </span>
          </FieldRow>
          <FieldRow label="Block hash">
            {block.block_hash ? (
              <CopyableCode value={block.block_hash} truncate={false} />
            ) : (
              <span className="text-ink-muted">—</span>
            )}
          </FieldRow>
          <FieldRow label="Parent hash">
            {block.parent_hash ? (
              <Link
                to="/blocks/$ref"
                params={{ ref: block.parent_hash }}
                className="font-mono text-[12px] text-ink-strong hover:underline break-all"
                title={block.parent_hash}
              >
                {shortHash(block.parent_hash, 10)}
              </Link>
            ) : (
              <span className="text-ink-muted">—</span>
            )}
          </FieldRow>
          <FieldRow label="Author">
            {block.author ? (
              <CopyableCode value={block.author} truncate={false} />
            ) : (
              <span className="text-ink-muted">—</span>
            )}
          </FieldRow>
          <FieldRow label="Extrinsics">
            <span className="font-mono text-sm text-ink tabular-nums">
              {formatNumber(block.extrinsic_count ?? 0)}
            </span>
          </FieldRow>
          <FieldRow label="Events">
            <span className="font-mono text-sm text-ink tabular-nums">
              {formatNumber(block.event_count ?? 0)}
            </span>
          </FieldRow>
          <FieldRow label="Observed at">
            <span className="font-mono text-[12px] text-ink-muted">
              <TimeAgo at={block.observed_at} />
              {block.observed_at ? (
                <span className="ml-2 opacity-70">{block.observed_at}</span>
              ) : null}
            </span>
          </FieldRow>
        </dl>
      </SectionAnchor>

      <div className="mt-6">
        <Link
          to="/blocks"
          className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium hover:border-ink/30"
        >
          ← All blocks
        </Link>
      </div>

      <ApiSourceFooter
        paths={[`/api/v1/blocks/${sourceRef}`]}
        artifacts={[`/metagraph/blocks/${sourceRef}.json`]}
      />
    </>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-muted sm:w-40 sm:shrink-0">
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <>
      <Skeleton className="h-28 w-full mb-8" />
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-72 w-full" />
    </>
  );
}
