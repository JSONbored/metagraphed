import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, type ReactNode } from "react";
import { Boxes, Clock, FileText } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { PageHero } from "@/components/metagraphed/page-hero";
import { ShareButton } from "@/components/metagraphed/share-button";
import { SectionAnchor } from "@/components/metagraphed/section-anchor";
import { EndpointSnippet } from "@/components/metagraphed/endpoint-snippet";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { extrinsicQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import {
  extrinsicCall,
  extrinsicHashPathSegment,
  isValidExtrinsicHash,
} from "@/lib/metagraphed/extrinsics";

export const Route = createFileRoute("/extrinsics/$hash")({
  // Prime the shared cache so head() can title with the call name. Non-fatal:
  // any failure falls back to the hash-only copy and the page's own
  // useSuspenseQuery still drives the not-found/empty path.
  loader: async ({ context, params }) => {
    if (!isValidExtrinsicHash(params.hash)) {
      return null;
    }
    try {
      const { data } = await context.queryClient.ensureQueryData(extrinsicQuery(params.hash));
      return {
        call: data ? extrinsicCall(data.call_module, data.call_function) : null,
      };
    } catch {
      return null;
    }
  },
  head: ({ params, loaderData }) => {
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
  component: ExtrinsicDetailPage,
});

function ExtrinsicDetailPage() {
  const { hash } = Route.useParams();
  return (
    <AppShell>
      <QueryErrorBoundary>
        <Suspense fallback={<DetailSkeleton />}>
          <ExtrinsicDetail hash={hash} />
        </Suspense>
      </QueryErrorBoundary>
    </AppShell>
  );
}

function ExtrinsicDetail({ hash }: { hash: string }) {
  if (!isValidExtrinsicHash(hash)) {
    return (
      <>
        <PageHeading
          eyebrow="Explorer"
          title="Invalid extrinsic reference"
          description="Extrinsic references must be a 0x-prefixed hexadecimal hash."
        />
        <EmptyState
          title="Invalid extrinsic reference"
          description="Use a 0x-prefixed hexadecimal extrinsic hash."
          action={{ label: "Back to extrinsics", href: "/extrinsics" }}
        />
      </>
    );
  }
  return <ValidExtrinsicDetail hash={hash} />;
}

function ValidExtrinsicDetail({ hash }: { hash: string }) {
  const sourceRef = extrinsicHashPathSegment(hash);
  const extrinsic = useSuspenseQuery(extrinsicQuery(hash)).data.data;
  const callArgs = extrinsic?.call_args;
  const events = (extrinsic?.events ?? []).slice(0, 100);
  // #3423: the events/call-args lists are sliced to bound render cost on an
  // already-fetched payload; surface how many rows were clipped so a viewer can
  // tell a complete record from a truncated one.
  const eventsTotal = extrinsic?.events?.length ?? 0;
  const eventsOmitted = Math.max(0, eventsTotal - events.length);
  const callArgsTotal = Array.isArray(callArgs)
    ? callArgs.length
    : callArgs && typeof callArgs === "object"
      ? Object.keys(callArgs).length
      : 0;
  const callArgsOmitted = Math.max(0, callArgsTotal - 64);

  if (!extrinsic) {
    return (
      <>
        <PageHeading
          eyebrow="Explorer"
          title={`Extrinsic ${shortHash(hash) ?? hash}`}
          description="This extrinsic isn't indexed yet."
        />
        <EmptyState
          title="Extrinsic not found or not yet indexed"
          description="The chain poller indexes recent extrinsics every few minutes. Cold or out-of-range extrinsics aren't available."
          action={{ label: "Back to extrinsics", href: "/extrinsics" }}
        />
        <ApiSourceFooter
          paths={[`/api/v1/extrinsics/${sourceRef}`]}
          artifacts={[`/metagraph/extrinsics/${sourceRef}.json`]}
        />
      </>
    );
  }

  const result = extrinsic.success == null ? "—" : extrinsic.success ? "Success" : "Failed";

  return (
    <>
      <PageHero
        eyebrow="Explorer · extrinsic"
        live
        title={shortHash(extrinsic.extrinsic_hash, 10) ?? "Extrinsic"}
        description={
          <span className="font-mono text-sm break-all">
            {extrinsicCall(extrinsic.call_module, extrinsic.call_function)}
          </span>
        }
        actions={<ShareButton />}
        caption="explorer / v1"
      />

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8">
        <StatTile
          icon={Boxes}
          eyebrow="Block"
          value={extrinsic.block_number != null ? `#${formatNumber(extrinsic.block_number)}` : "—"}
        />
        <StatTile icon={FileText} eyebrow="Result" value={result} />
        <StatTile
          icon={Clock}
          eyebrow="Observed"
          value={<TimeAgo at={extrinsic.observed_at} />}
          tone="accent"
        />
      </div>

      <SectionAnchor id="details" title="Extrinsic details" tone="accent">
        <dl className="rounded border border-border bg-card divide-y divide-border">
          <FieldRow label="Extrinsic hash">
            {extrinsic.extrinsic_hash ? (
              <CopyableCode value={extrinsic.extrinsic_hash} truncate={false} />
            ) : (
              <span className="text-ink-muted">—</span>
            )}
          </FieldRow>
          <FieldRow label="Block">
            {extrinsic.block_number != null ? (
              <Link
                to="/blocks/$ref"
                params={{ ref: String(extrinsic.block_number) }}
                className="font-mono text-sm text-ink-strong hover:underline tabular-nums"
              >
                #{formatNumber(extrinsic.block_number)}
              </Link>
            ) : (
              <span className="text-ink-muted">—</span>
            )}
          </FieldRow>
          <FieldRow label="Index in block">
            <span className="font-mono text-sm text-ink tabular-nums">
              {extrinsic.extrinsic_index != null ? formatNumber(extrinsic.extrinsic_index) : "—"}
            </span>
          </FieldRow>
          <FieldRow label="Call">
            <span className="font-mono text-sm text-ink-strong">
              {extrinsicCall(extrinsic.call_module, extrinsic.call_function)}
            </span>
          </FieldRow>
          <FieldRow label="Signer">
            {extrinsic.signer ? (
              <CopyableCode value={extrinsic.signer} truncate={false} />
            ) : (
              <span className="text-ink-muted">—</span>
            )}
          </FieldRow>
          <FieldRow label="Result">
            <span className="font-mono text-sm text-ink">{result}</span>
          </FieldRow>
          <FieldRow label="Inclusion fee">
            <span className="font-mono text-sm text-ink-strong">
              {extrinsic.fee_tao != null ? formatTao(extrinsic.fee_tao) : "—"}
            </span>
          </FieldRow>
          <FieldRow label="Tip">
            <span className="font-mono text-sm text-ink-strong">
              {extrinsic.tip_tao != null ? formatTao(extrinsic.tip_tao) : "—"}
            </span>
          </FieldRow>
          <FieldRow label="Observed at">
            <span className="font-mono text-[12px] text-ink-muted">
              <TimeAgo at={extrinsic.observed_at} />
              {extrinsic.observed_at ? (
                <span className="ml-2 opacity-70">{extrinsic.observed_at}</span>
              ) : null}
            </span>
          </FieldRow>
        </dl>
      </SectionAnchor>

      <SectionAnchor
        id="call-args"
        title="Call arguments"
        subtitle="The decoded parameters passed to this extrinsic."
      >
        {renderCallArgs(callArgs)}
        {callArgsOmitted > 0 ? (
          <p className="mt-2 font-mono text-[11px] text-ink-muted">
            Showing 64 of {formatNumber(callArgsTotal)} call args — {formatNumber(callArgsOmitted)}{" "}
            more omitted.
          </p>
        ) : null}
      </SectionAnchor>

      <SectionAnchor id="events" title="Emitted events" tone="accent">
        {events.length > 0 ? (
          <div className="overflow-x-auto rounded border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface/40">
                <tr>
                  <th className="px-4 py-2.5">Block</th>
                  <th className="px-4 py-2.5">Kind</th>
                  <th className="px-4 py-2.5">Hotkey</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                  <th className="px-4 py-2.5 text-right">Observed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map((ev, i) => (
                  <tr
                    key={`${ev.block_number}-${ev.event_index}-${i}`}
                    className="hover:bg-surface/40"
                  >
                    <td className="px-4 py-2.5 font-mono text-[12px]">
                      {ev.block_number != null ? (
                        <Link
                          to="/blocks/$ref"
                          params={{ ref: String(ev.block_number) }}
                          className="text-ink hover:underline"
                        >
                          #{formatNumber(ev.block_number)}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink-strong">
                      {ev.event_kind ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px]">
                      {ev.hotkey ? (
                        <Link
                          to="/accounts/$ss58"
                          params={{ ss58: ev.hotkey }}
                          className="text-ink-muted hover:text-ink hover:underline"
                        >
                          {shortHash(ev.hotkey) ?? ev.hotkey}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink">
                      {ev.amount_tao != null ? `${formatNumber(ev.amount_tao)} τ` : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted">
                      <TimeAgo at={ev.observed_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No emitted events"
            description="No emitted events were indexed for this extrinsic."
          />
        )}
        {eventsOmitted > 0 ? (
          <p className="mt-2 font-mono text-[11px] text-ink-muted">
            Showing 100 of {formatNumber(eventsTotal)} events — {formatNumber(eventsOmitted)} more
            omitted.
          </p>
        ) : null}
      </SectionAnchor>

      <div className="mt-6">
        <Link
          to="/extrinsics"
          className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium hover:border-ink/30"
        >
          ← All extrinsics
        </Link>
      </div>

      <SectionAnchor
        id="call"
        title="Call this endpoint"
        subtitle="Copy a ready-to-run request for this extrinsic."
      >
        <EndpointSnippet
          rows={[
            { label: "extrinsic", path: `/api/v1/extrinsics/${sourceRef}` },
            { label: "artifact", path: `/metagraph/extrinsics/${sourceRef}.json` },
          ]}
        />
      </SectionAnchor>

      <ApiSourceFooter
        paths={[`/api/v1/extrinsics/${sourceRef}`]}
        artifacts={[`/metagraph/extrinsics/${sourceRef}.json`]}
      />
    </>
  );
}

function renderCallArgs(callArgs: unknown) {
  if (Array.isArray(callArgs)) {
    const args = (callArgs as Array<{ name?: string | null; value?: unknown }>).slice(0, 64);
    if (args.length === 0) {
      return <p className="text-sm text-ink-muted">No call args were indexed.</p>;
    }
    return (
      <div className="overflow-x-auto rounded border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface/40">
            <tr>
              <th className="px-4 py-2.5">Name</th>
              <th className="px-4 py-2.5">Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {args.map((arg, i) => (
              <tr key={`${arg.name ?? i}`} className="hover:bg-surface/40">
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-strong">
                  {arg.name ?? `arg_${i + 1}`}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                  {formatCallArgValue(arg.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (callArgs && typeof callArgs === "object") {
    const entries = Object.entries(callArgs as Record<string, unknown>).slice(0, 64);
    if (entries.length === 0) {
      return <p className="text-sm text-ink-muted">No call args were indexed.</p>;
    }
    return (
      <div className="overflow-x-auto rounded border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface/40">
            <tr>
              <th className="px-4 py-2.5">Key</th>
              <th className="px-4 py-2.5">Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {entries.map(([key, value]) => (
              <tr key={key} className="hover:bg-surface/40">
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-strong">{key}</td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                  {formatCallArgValue(value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return <p className="text-sm text-ink-muted">No call args were indexed.</p>;
}

function formatCallArgValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null || value === undefined) return "—";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[Unserializable value]";
  }
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
