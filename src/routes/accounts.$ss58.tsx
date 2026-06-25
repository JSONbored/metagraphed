import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { Activity, Boxes, Clock, Coins } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import { PageHero } from "@/components/metagraphed/page-hero";
import { SectionAnchor } from "@/components/metagraphed/section-anchor";
import { EndpointSnippet } from "@/components/metagraphed/endpoint-snippet";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { accountBalanceQuery, accountQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { isValidSs58, ss58PathSegment } from "@/lib/metagraphed/accounts";
import type { AccountSummary } from "@/lib/metagraphed/types";

export const Route = createFileRoute("/accounts/$ss58")({
  head: ({ params }) => {
    const label = shortHash(params.ss58) ?? params.ss58;
    const title = `Account ${label} — Metagraphed`;
    const description = `Bittensor account ${label}: cross-subnet activity, registrations, and first-party chain-event history on Metagraphed.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
      ],
    };
  },
  component: AccountDetailPage,
});

function AccountDetailPage() {
  const { ss58 } = Route.useParams();
  return (
    <AppShell>
      <QueryErrorBoundary>
        <Suspense fallback={<DetailSkeleton />}>
          <AccountDetail ss58={ss58} />
        </Suspense>
      </QueryErrorBoundary>
    </AppShell>
  );
}

function AccountDetail({ ss58 }: { ss58: string }) {
  if (!isValidSs58(ss58)) {
    return (
      <>
        <PageHeading
          eyebrow="Explorer"
          title="Invalid account address"
          description="Account addresses must be a valid ss58 (base58) string."
        />
        <EmptyState
          title="Invalid account address"
          description="Use a valid hotkey or coldkey ss58 address."
          action={{ label: "Back to accounts", href: "/accounts" }}
        />
      </>
    );
  }
  return <ValidAccountDetail ss58={ss58} />;
}

// Compact TAO formatter — mirrors the economics panel's fmtTao convention.
function fmtTao(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M τ`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k τ`;
  if (v >= 1) return `${v.toFixed(2)} τ`;
  return `${v.toFixed(4)} τ`;
}

function ValidAccountDetail({ ss58 }: { ss58: string }) {
  const sourceRef = ss58PathSegment(ss58);
  const account = useSuspenseQuery(accountQuery(ss58)).data.data as AccountSummary;
  // Balance is a separate live-RPC call: fetched non-blocking so a slow/failed
  // RPC never stalls or errors the rest of the entity page.
  const balanceResult = useQuery(accountBalanceQuery(ss58));
  const balance = balanceResult.data?.data;

  const balanceValue = balanceResult.isPending ? (
    <span className="text-ink-muted">…</span>
  ) : balance?.balance_tao != null ? (
    fmtTao(balance.balance_tao)
  ) : (
    "—"
  );

  const hasActivity =
    account.event_count > 0 || account.registrations.length > 0 || account.recent_events.length > 0;

  return (
    <>
      <PageHero
        eyebrow="Explorer · account"
        live
        title={shortHash(ss58, 8) ?? "Account"}
        description={<CopyableCode value={ss58} truncate={false} />}
        caption="explorer / v1"
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <StatTile
          icon={Coins}
          eyebrow="Balance"
          value={balanceValue}
          hint={balance?.balance_tao != null ? "free + reserved · live RPC" : "live RPC"}
          tone="accent"
        />
        <StatTile icon={Activity} eyebrow="Events" value={formatNumber(account.event_count)} />
        <StatTile icon={Boxes} eyebrow="Subnets" value={formatNumber(account.subnet_count)} />
        <StatTile
          icon={Clock}
          eyebrow="Last seen"
          value={<TimeAgo at={account.last_seen_at ?? undefined} />}
        />
      </div>

      {!hasActivity ? (
        <EmptyState
          title="No activity indexed for this account"
          description="The chain poller indexes first-party events for recent blocks. Cold accounts or those without recent on-chain activity won't appear yet."
          action={{ label: "Back to accounts", href: "/accounts" }}
        />
      ) : null}

      {account.registrations.length > 0 ? (
        <SectionAnchor id="registrations" title="Registered subnets" tone="accent">
          <div className="overflow-x-auto rounded border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface/40">
                <tr>
                  <th className="px-4 py-2.5">Subnet</th>
                  <th className="px-4 py-2.5 text-right">UID</th>
                  <th className="px-4 py-2.5 text-right">Stake</th>
                  <th className="px-4 py-2.5">Permit</th>
                  <th className="px-4 py-2.5">Active</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {account.registrations.map((r) => (
                  <tr key={`${r.netuid}-${r.uid}`} className="hover:bg-surface/40">
                    <td className="px-4 py-2.5 font-mono text-[12px]">
                      {r.netuid != null ? (
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: r.netuid }}
                          className="font-medium text-ink-strong hover:underline"
                        >
                          SN{r.netuid}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                      {r.uid != null ? formatNumber(r.uid) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                      {r.stake_tao != null ? `${formatNumber(r.stake_tao)} τ` : "—"}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px]">
                      {r.validator_permit ? (
                        <span className="text-emerald-500">validator</span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px]">
                      {r.active ? (
                        <span className="text-emerald-500">active</span>
                      ) : (
                        <span className="text-ink-muted">idle</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionAnchor>
      ) : null}

      {account.event_kinds.length > 0 ? (
        <SectionAnchor id="kinds" title="Activity by kind" tone="accent">
          <div className="flex flex-wrap gap-2">
            {account.event_kinds.map((entry) => (
              <span
                key={entry.kind}
                className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 font-mono text-[11px]"
              >
                <span className="text-ink-strong">{entry.kind}</span>
                <span className="text-ink-muted tabular-nums">{formatNumber(entry.count)}</span>
              </span>
            ))}
          </div>
        </SectionAnchor>
      ) : null}

      {account.recent_events.length > 0 ? (
        <SectionAnchor id="events" title="Recent events" tone="accent">
          <div className="overflow-x-auto rounded border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface/40">
                <tr>
                  <th className="px-4 py-2.5">Block</th>
                  <th className="px-4 py-2.5">Kind</th>
                  <th className="px-4 py-2.5">Subnet</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                  <th className="px-4 py-2.5 text-right">Observed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {account.recent_events.map((ev, i) => (
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
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                      {ev.netuid != null ? `SN${ev.netuid}` : "—"}
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
        </SectionAnchor>
      ) : null}

      <div className="mt-6">
        <Link
          to="/accounts"
          className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium hover:border-ink/30"
        >
          ← Account lookup
        </Link>
      </div>

      <SectionAnchor
        id="call"
        title="Call this endpoint"
        subtitle="Copy a ready-to-run request for this account."
      >
        <EndpointSnippet
          rows={[
            { label: "summary", path: `/api/v1/accounts/${sourceRef}` },
            { label: "balance", path: `/api/v1/accounts/${sourceRef}/balance` },
            { label: "events", path: `/api/v1/accounts/${sourceRef}/events` },
            { label: "subnets", path: `/api/v1/accounts/${sourceRef}/subnets` },
          ]}
        />
      </SectionAnchor>

      <ApiSourceFooter paths={[`/api/v1/accounts/${sourceRef}`]} />
    </>
  );
}

function DetailSkeleton() {
  return (
    <>
      <Skeleton className="h-28 w-full mb-8" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-72 w-full" />
    </>
  );
}
