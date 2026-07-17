import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, type ReactNode } from "react";
import { Boxes, Clock, FileText, Link2, UserCog } from "lucide-react";
import { AccountAddress } from "@/components/metagraphed/account-address";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { EndpointSnippet } from "@/components/metagraphed/endpoint-snippet";
import {
  CopyableCode,
  TimeAgo,
  PageHero,
  ShareButton,
  ActionBar,
  SectionAnchor,
  StatTile,
  TableState,
} from "@jsonbored/ui-kit";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { extrinsicQuery, extrinsicsQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { unwrapByteArray, decodeBytesField } from "@/lib/metagraphed/bytes";
import { eventKindLabel } from "@/lib/metagraphed/event-kinds";
import {
  asDecodedCall,
  extrinsicCall,
  extrinsicHashPathSegment,
  isValidExtrinsicHash,
  multisigCallHash,
  proxyRealAccount,
  type DecodedCall,
} from "@/lib/metagraphed/extrinsics";

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
  // The router's parseParams rejects malformed hashes before this renders, so
  // the detail component only ever runs with a well-formed hash.
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
  const eventsTotal =
    typeof extrinsic?.events_total === "number"
      ? extrinsic.events_total
      : (extrinsic?.events?.length ?? 0);
  const eventsOmitted = Math.max(0, eventsTotal - events.length);
  const callArgsTotal =
    typeof extrinsic?.call_args_total === "number"
      ? extrinsic.call_args_total
      : Array.isArray(callArgs)
        ? callArgs.length
        : callArgs && typeof callArgs === "object"
          ? Object.keys(callArgs).length
          : 0;
  const callArgsOmitted = Math.max(0, callArgsTotal - 64);
  const realAccount = extrinsic
    ? proxyRealAccount(extrinsic.call_module, extrinsic.call_function, callArgs)
    : null;
  // #4322: link a Multisig call to the rest of its approval chain (the
  // initiating `as_multi`, later `approve_as_multi`s, the final execution) --
  // all of them carry the same call_hash. A plain useQuery (not suspense):
  // this is a secondary, best-effort section, so a slow/failed lookup
  // shouldn't block or error the whole page. Hook order must stay stable
  // regardless of `extrinsic`, so this runs before the not-found early return
  // below and is simply disabled when there's no hash to look up.
  const callHash = extrinsic ? multisigCallHash(extrinsic.call_module, callArgs) : null;
  const relatedQuery = useQuery({
    ...extrinsicsQuery({ call_module: "Multisig", call_hash: callHash ?? "", limit: 25 }),
    enabled: Boolean(callHash),
  });
  const relatedCalls = (relatedQuery.data?.data ?? []).filter(
    (e) => e.extrinsic_hash?.toLowerCase() !== hash.toLowerCase(),
  );

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
        actions={
          <ActionBar>
            <ShareButton bare />
          </ActionBar>
        }
        caption="explorer / v1"
      />

      {realAccount ? (
        <div className="mb-8 flex flex-wrap items-center gap-3 rounded border border-accent/30 bg-accent-surface px-4 py-3">
          <UserCog className="size-4 shrink-0 text-accent" aria-hidden="true" />
          <span className="text-sm text-ink">
            Executed on behalf of{" "}
            <Link
              to="/accounts/$ss58"
              params={{ ss58: realAccount }}
              className="font-mono text-ink-strong hover:underline"
            >
              {shortHash(realAccount) ?? realAccount}
            </Link>{" "}
            — the account below only relayed this <code className="font-mono">Proxy.proxy</code>{" "}
            call, it isn't the account the inner call actually acts as.
          </span>
        </div>
      ) : null}

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
              <CopyableCode
                value={extrinsic.extrinsic_hash}
                truncate={false}
                className="max-w-full"
              />
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
            <span className="font-mono text-sm text-ink-strong break-all">
              {extrinsicCall(extrinsic.call_module, extrinsic.call_function)}
            </span>
          </FieldRow>
          <FieldRow label="Signer">
            {/* #6424: linked like every other ss58 on this page (see the events
                table below) -- untruncated, so the full value stays readable and
                copyable exactly as it was. */}
            <AccountAddress
              ss58={extrinsic.signer}
              truncate={false}
              fallback={<span className="text-ink-muted">—</span>}
            />
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
        {renderCallArgs(callArgs, extrinsic.call_module, extrinsic.call_function)}
        {callArgsOmitted > 0 ? (
          <p className="mt-2 font-mono text-[11px] text-ink-muted">
            Showing 64 of {formatNumber(callArgsTotal)} call args — {formatNumber(callArgsOmitted)}{" "}
            more omitted.
          </p>
        ) : null}
      </SectionAnchor>

      {callHash ? (
        <SectionAnchor
          id="multisig-chain"
          title="Related Multisig calls"
          subtitle="Other extrinsics approving or executing this same call_hash."
          tone="accent"
        >
          {relatedQuery.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : relatedQuery.isError ? (
            // Without this branch a failed lookup left `data` undefined, so
            // `relatedCalls` fell through to [] and rendered the same "no other
            // extrinsics" copy as a genuinely empty result -- the one case where
            // this page asserted something it hadn't actually learned (#6426).
            <TableState
              variant="error"
              title="Couldn't load related Multisig calls"
              description="The related-calls lookup is optional enrichment — the rest of this extrinsic's detail is unaffected."
              error={relatedQuery.error}
              onRetry={() => relatedQuery.refetch()}
            />
          ) : relatedCalls.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {relatedCalls.map((e) => (
                <li key={e.extrinsic_hash ?? `${e.block_number}-${e.extrinsic_index}`}>
                  <Link
                    to="/extrinsics/$hash"
                    params={{ hash: e.extrinsic_hash ?? "" }}
                    className="flex items-center gap-2 rounded border border-border bg-card px-3 py-2 text-sm hover:border-ink/30"
                  >
                    <Link2 className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                    <span className="font-mono text-ink-strong">
                      {extrinsicCall(e.call_module, e.call_function)}
                    </span>
                    <span className="text-ink-muted">·</span>
                    <span className="font-mono text-[11px] text-ink-muted">
                      #{formatNumber(e.block_number ?? 0)}
                    </span>
                    <TimeAgo at={e.observed_at} className="ml-auto text-[11px] text-ink-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-muted">
              No other extrinsics reference this call_hash yet.
            </p>
          )}
        </SectionAnchor>
      ) : null}

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
                    <td
                      className="px-4 py-2.5 font-mono text-[11px] text-ink-strong"
                      title={ev.event_kind ?? undefined}
                    >
                      {eventKindLabel(ev.event_kind)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                      <AccountAddress ss58={ev.hotkey} copyButtonClassName="-my-3.5" fallback="—" />
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

// Utility.batch/batch_all/force_batch, Multisig's `call`, and Proxy's `call`
// all carry the SAME fully-decoded-call shape (#4319/4.1 — verified live, see
// docs/block-explorer-data-model.md's "Nested-call decode depth" note), and
// that decoded call's own args can nest again (a batch inside a multisig
// inside a batch). Cap the recursion rather than flattening to raw JSON, so a
// viewer can read a batch's inner transfers/multisig's wrapped call directly
// instead of parsing an escaped JSON blob by eye.
const MAX_NESTED_CALL_DEPTH = 4;

function renderCallArgs(
  callArgs: unknown,
  callModule: string | null | undefined,
  callFunction: string | null | undefined,
  depth = 0,
) {
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
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-strong align-top">
                  {arg.name ?? `arg_${i + 1}`}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                  {renderCallArgValue(arg.value, arg.name, callModule, callFunction, depth)}
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
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-strong align-top">
                  {key}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                  {renderCallArgValue(value, key, callModule, callFunction, depth)}
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

// One arg's value: a nested call (or a list of them, e.g. a batch's `calls`)
// expands as its own call card; anything else prints as before. asDecodedCall
// (not the bare isDecodedCall predicate) so this recognizes a nested call
// under EITHER ingestion pipeline's shape (#4669) -- D1's
// {call_module,call_function,...} directly, or indexer-rs's {name,values}
// enum-tree wrapper, normalized to the same shape before rendering.
//
// A raw byte-blob value (Postgres/indexer-rs's Vec<u8>/BoundedVec<u8>/Bytes
// shape, #4689) decodes via decodeBytesField before falling to the generic
// JSON dump -- this runs AFTER the nested-call checks (mutually exclusive
// shapes: a decoded call requires string call_module/call_function fields,
// never a bare integer array) and is deliberately generic on VALUE shape
// alone, not fieldName -- unlike an eventual AccountId32 check (#4691, not
// yet wired here), which must run before this to avoid this ever
// hex-encoding what should be an SS58 address.
function renderCallArgValue(
  value: unknown,
  fieldName: string | null | undefined,
  callModule: string | null | undefined,
  callFunction: string | null | undefined,
  depth: number,
): ReactNode {
  if (depth < MAX_NESTED_CALL_DEPTH) {
    const decoded = asDecodedCall(value);
    if (decoded) {
      return <NestedCallCard call={decoded} depth={depth} />;
    }
    if (Array.isArray(value) && value.length > 0) {
      const decodedCalls = value.map(asDecodedCall);
      if (decodedCalls.every((c): c is DecodedCall => c !== null)) {
        return (
          <div className="flex flex-col gap-2">
            {decodedCalls.map((call, i) => (
              <NestedCallCard
                key={typeof call.call_hash === "string" ? call.call_hash : i}
                call={call}
                depth={depth}
              />
            ))}
          </div>
        );
      }
    }
  }
  // length > 0: an empty array is vacuously a valid (empty) byte blob per
  // unwrapByteArray's own contract, but it's indistinguishable from a
  // genuinely empty Vec<T> of some other element type (e.g. a Multisig with
  // no other_signatories) -- default to the generic "[]" JSON rendering for
  // that ambiguous case rather than a misleading "0x".
  const bytes = unwrapByteArray(value);
  if (bytes && bytes.length > 0) {
    return decodeBytesField(callModule, callFunction, fieldName ?? "", bytes);
  }
  return formatCallArgValue(value);
}

function NestedCallCard({ call, depth }: { call: DecodedCall; depth: number }) {
  return (
    <div className="rounded border border-border/70 bg-surface/30 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-semibold text-ink-strong">
          {extrinsicCall(call.call_module, call.call_function)}
        </span>
        {typeof call.call_hash === "string" && call.call_hash ? (
          <CopyableCode value={call.call_hash} label="call_hash" />
        ) : null}
      </div>
      {renderCallArgs(call.call_args, call.call_module, call.call_function, depth + 1)}
    </div>
  );
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
