import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Fragment, Suspense, useState, type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  Boxes,
  TrendingUp,
  Sparkles,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Coins,
  Fingerprint,
  Gauge,
  Github,
  Globe,
  MessageCircle,
  Radar,
  RefreshCw,
  Rows3,
  Scale,
  Unplug,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, PageHeading, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { SelectFilter, FilterChip } from "@/components/metagraphed/table-controls";
import { EndpointSnippet } from "@/components/metagraphed/endpoint-snippet";
import {
  CopyableCode,
  TimeAgo,
  TableState,
  PageHero,
  ShareButton,
  ActionBar,
  SectionAnchor,
  StatTile,
  BarMini,
  DownloadCsvButton,
  ExternalLink,
} from "@jsonbored/ui-kit";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { AccountHistoryChart } from "@/components/metagraphed/account-history-chart";
import { AccountPositionHistoryChart } from "@/components/metagraphed/account-position-history-chart";
import {
  accountAxonRemovalsQuery,
  accountCounterpartiesQuery,
  accountStakeFlowQuery,
  accountPortfolioQuery,
  accountStakeMovesQuery,
  accountDeregistrationsQuery,
  accountRegistrationsQuery,
  accountWeightSettersQuery,
  accountBalanceQuery,
  accountIdentityQuery,
  accountEventsQuery,
  accountExtrinsicsQuery,
  accountPrometheusQuery,
  accountQuery,
  accountServingQuery,
  accountSubnetsQuery,
  accountTransfersQuery,
} from "@/lib/metagraphed/queries";
import { classNames, formatNumber, formatTao, isStaleFreshness } from "@/lib/metagraphed/format";
import { buildUrl } from "@/lib/metagraphed/client";
import { shortHash } from "@/lib/metagraphed/blocks";
import { extrinsicCall } from "@/lib/metagraphed/extrinsics";
import { isValidSs58, ss58PathSegment } from "@/lib/metagraphed/accounts";
import { accountFeedSectionPhase } from "@/lib/metagraphed/account-feed-section";
import { eventKindLabel } from "@/lib/metagraphed/event-kinds";
import { subnetPositionSearch } from "@/lib/metagraphed/subnet-position-link";
import { entityNotFoundMeta } from "@/lib/metagraphed/entity-not-found-meta";
import type {
  AccountCounterparty,
  AccountStakeFlowSubnet,
  AccountRegistration,
  AccountSummary,
  Extrinsic,
  Transfer,
} from "@/lib/metagraphed/types";

type SearchParams = {
  // Paginated /events feed controls (#266). Prefixed so they never collide with
  // other future per-account search params.
  ev_kind?: string;
  ev_limit?: number;
  ev_offset?: number;
};

const EVENTS_LIMITS = [25, 50, 100, 200] as const;
const DEFAULT_EVENTS_LIMIT = 25;

export const Route = createFileRoute("/accounts/$ss58")({
  validateSearch: (s: Record<string, unknown>): SearchParams => {
    const limitNum = Number(s.ev_limit);
    const offsetNum = Number(s.ev_offset);
    return {
      ev_kind: typeof s.ev_kind === "string" && s.ev_kind ? s.ev_kind : undefined,
      ev_limit: (EVENTS_LIMITS as readonly number[]).includes(limitNum) ? limitNum : undefined,
      ev_offset: Number.isInteger(offsetNum) && offsetNum > 0 ? offsetNum : undefined,
    };
  },
  // #6429: validate the ss58 at the router level, matching blocks.$ref.tsx
  // (#3422) and subnets.$netuid.tsx. parseParams runs before head()/the loader,
  // so an invalid address renders the real not-found boundary instead of a
  // fully-formed page whose metadata interpolates the bad param.
  parseParams: ({ ss58 }) => {
    if (!isValidSs58(ss58)) throw notFound();
    return { ss58 };
  },
  head: ({ params }) => {
    // parseParams above rejects a malformed ss58, but head() still runs with the
    // raw param -- verified against the routes that already validate: /blocks/
    // not-a-ref titles "Block not-a-ref" and /subnets/not-a-netuid titles
    // "Subnet not-a-netuid" today. So the not-found metadata is guarded here
    // too, or the boundary would render under a title asserting the bad id is a
    // real account (#6429).
    if (!isValidSs58(params.ss58)) {
      return entityNotFoundMeta(
        "Account",
        "This account identifier is not a valid Bittensor ss58 address.",
      );
    }
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
  notFoundComponent: () => (
    <AppShell>
      <PageHeading
        eyebrow="Explorer"
        title="Invalid account address"
        description="Account addresses are ss58 (base58) strings, 46–49 characters long."
      />
      <EmptyState
        title="Invalid account address"
        description="Bittensor addresses use the base58 alphabet (no 0, O, I, or l), are 46–49 characters long, and typically start with 5. Check for a truncated or wrong-chain address, then try again."
        action={{ label: "Back to accounts", href: "/accounts" }}
      />
      <p className="mt-3 text-center text-[11px] text-ink-muted">
        Example:{" "}
        <span className="font-mono break-all text-ink-strong">
          5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY
        </span>
      </p>
    </AppShell>
  ),
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

// The router's parseParams guarantees a well-formed ss58 here (#6429), so this
// no longer re-checks it -- same shape as blocks.$ref.tsx's BlockDetailPage.
function AccountDetail({ ss58 }: { ss58: string }) {
  return <ValidAccountDetail ss58={ss58} />;
}

function ValidAccountDetail({ ss58 }: { ss58: string }) {
  const sourceRef = ss58PathSegment(ss58);
  const accountResult = useSuspenseQuery(accountQuery(ss58)).data;
  const account = accountResult.data as AccountSummary;
  const generatedAt = accountResult.meta?.generated_at ?? null;
  // Balance is a separate live-RPC call: fetched non-blocking so a slow/failed
  // RPC never stalls or errors the rest of the entity page.
  const balanceResult = useQuery(accountBalanceQuery(ss58));
  const balance = balanceResult.data?.data;
  // Signed extrinsics + native-TAO transfers are separate sub-resources (#264),
  // fetched non-blocking so a cold/slow tier never stalls the summary above.
  const extrinsicsResult = useQuery(accountExtrinsicsQuery(ss58, { limit: 25 }));
  const transfersResult = useQuery(accountTransfersQuery(ss58, { limit: 25 }));
  const signedExtrinsics = extrinsicsResult.data?.data ?? [];
  const transfers = transfersResult.data?.data ?? [];

  const balanceValue = balanceResult.isError ? (
    <span className="inline-flex items-center gap-2">
      <AlertCircle aria-hidden className="size-4 text-health-down" />
      <span className="text-base font-medium text-health-down">Unavailable</span>
      <button
        type="button"
        onClick={() => void balanceResult.refetch()}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-paper px-2 py-0.5 text-[11px] font-medium text-ink hover:border-accent/50 hover:text-accent transition-colors"
      >
        <RefreshCw className="size-3" /> Retry
      </button>
    </span>
  ) : balanceResult.isPending ? (
    <span className="text-ink-muted">…</span>
  ) : balance?.balance_tao != null ? (
    formatTao(balance.balance_tao)
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
        description={
          <div className="space-y-4">
            <p className="max-w-2xl">
              Cross-subnet registrations, first-party chain events, and daily activity rollups for
              one Bittensor account.
            </p>
            <div className="max-w-full sm:max-w-fit rounded-2xl border border-border/80 bg-card/80 px-3 py-2 mg-card-glow">
              <CopyableCode value={ss58} truncate={false} className="max-w-full" />
            </div>
          </div>
        }
        actions={
          <>
            <ActionBar>
              <ShareButton bare />
            </ActionBar>
            <a
              href="#history"
              className="inline-flex items-center rounded-full border border-accent/30 bg-accent/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-text transition-colors hover:bg-accent/15"
            >
              View activity
            </a>
            <a
              href="#call"
              className="inline-flex items-center rounded-full border border-border bg-card px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted transition-colors hover:border-ink/20 hover:text-ink-strong"
            >
              API endpoints
            </a>
            {isStaleFreshness(generatedAt) ? (
              <StaleBanner
                compact
                generatedAt={generatedAt}
                refreshQueryKeys={[accountQuery(ss58).queryKey]}
              />
            ) : null}
          </>
        }
        aside={
          <AccountHeroAside
            registrations={account.registrations.length}
            eventKinds={account.event_kinds.length}
            firstSeenAt={account.first_seen_at ?? null}
          />
        }
        caption="explorer / v1"
      />

      <div className="mb-12 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon={balanceResult.isError ? AlertCircle : Coins}
          eyebrow="Balance"
          value={balanceValue}
          hint={
            balanceResult.isError
              ? "live RPC failed"
              : balance?.balance_tao != null
                ? "free + reserved · live RPC"
                : "live RPC"
          }
          tone={balanceResult.isError ? "down" : "accent"}
          className="rounded-2xl bg-card/95 p-5 mg-card-glow-accent"
        />
        <StatTile
          icon={Activity}
          eyebrow="Events"
          value={formatNumber(account.event_count)}
          hint="indexed first-party"
          className="rounded-2xl border-border/80 bg-card/95 p-5 mg-card-glow"
        />
        <StatTile
          icon={Boxes}
          eyebrow="Subnets"
          value={formatNumber(account.subnet_count)}
          hint="active footprint"
          className="rounded-2xl border-border/80 bg-card/95 p-5 mg-card-glow"
        />
        <StatTile
          icon={Clock}
          eyebrow="Last seen"
          value={<TimeAgo at={account.last_seen_at ?? undefined} />}
          hint="near-realtime · chain-direct index"
          className="rounded-2xl border-border/80 bg-card/95 p-5 mg-card-glow"
        />
      </div>

      <AccountIdentitySection ss58={ss58} />

      <SectionAnchor
        id="history"
        title="Daily activity"
        subtitle="Per-day first-party account events, newest rollups from the chain-direct explorer."
        tone="accent"
        info="History is keyed by hotkey activity only. Coldkey-only addresses legitimately return an empty series."
        right={<SectionBadge tone="accent">hotkey rollup</SectionBadge>}
      >
        <AccountHistoryChart ss58={ss58} />
      </SectionAnchor>

      {!hasActivity ? (
        <EmptyState
          title="No activity indexed for this account"
          description="The chain poller indexes first-party events for recent blocks. Cold accounts or those without recent on-chain activity won't appear yet."
          action={{ label: "Back to accounts", href: "/accounts" }}
        />
      ) : null}

      <AccountFootprintSection ss58={ss58} fallback={account.registrations} />
      {/* #3341: staking-flow scorecard over the same subnet footprint. */}
      <AccountStakeFlowSection ss58={ss58} />

      <AccountPortfolioSection ss58={ss58} />
      <AccountStakeMovesSection ss58={ss58} />

      <AccountTeardownActivitySection ss58={ss58} />

      <AccountRegistrationActivitySection ss58={ss58} />
      <AccountDeregistrationActivitySection ss58={ss58} />

      <AccountWeightSettingSection ss58={ss58} />

      <AccountEndpointAnnouncementSection ss58={ss58} />

      {account.event_kinds.length > 0 ? (
        <SectionAnchor
          id="kinds"
          title="Activity by kind"
          subtitle="Relative event mix across the indexed sample for this account."
          tone="accent"
          right={<SectionBadge>{formatNumber(account.event_kinds.length)} kinds</SectionBadge>}
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {account.event_kinds.map((entry) => (
              <div
                key={entry.kind}
                className="rounded-2xl border border-border/80 bg-card/95 px-4 py-3 mg-card-glow"
              >
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
                  event kind
                </div>
                <div className="mt-2 flex items-end justify-between gap-3">
                  <span className="min-w-0 truncate font-mono text-[12px] text-ink-strong">
                    {entry.kind}
                  </span>
                  <span className="font-display text-xl font-semibold tabular-nums text-ink-strong">
                    {formatNumber(entry.count)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </SectionAnchor>
      ) : null}

      <AccountEventsSection ss58={ss58} kindOptions={account.event_kinds} />

      <AccountExtrinsicsSection
        ss58={ss58}
        rows={signedExtrinsics}
        isPending={extrinsicsResult.isPending}
        isError={extrinsicsResult.isError}
        error={extrinsicsResult.error}
        onRetry={() => void extrinsicsResult.refetch()}
      />
      <AccountTransfersSection
        ss58={ss58}
        rows={transfers}
        isPending={transfersResult.isPending}
        isError={transfersResult.isError}
        error={transfersResult.error}
        onRetry={() => void transfersResult.refetch()}
      />
      {/* #3340: the aggregated fund-flow view over the same transfer data. */}
      <AccountCounterpartiesSection ss58={ss58} />

      {/* #6432: deliberately NOT "← All accounts" like the other detail pages'
          back-links. /accounts is a lookup form, not an index -- there is no
          list of every chain account to go back to -- so the label names what
          the destination actually is. Sibling pages (blocks, extrinsics,
          validators, subnets) do point at real directories and use "← All X". */}
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
            { label: "identity", path: `/api/v1/accounts/${sourceRef}/identity` },
            { label: "history", path: `/api/v1/accounts/${sourceRef}/history` },
            { label: "events", path: `/api/v1/accounts/${sourceRef}/events` },
            { label: "subnets", path: `/api/v1/accounts/${sourceRef}/subnets` },
            { label: "counterparties", path: `/api/v1/accounts/${sourceRef}/counterparties` },
            { label: "stake-flow", path: `/api/v1/accounts/${sourceRef}/stake-flow` },
            { label: "serving", path: `/api/v1/accounts/${sourceRef}/serving` },
            { label: "prometheus", path: `/api/v1/accounts/${sourceRef}/prometheus` },
          ]}
        />
      </SectionAnchor>

      <ApiSourceFooter
        paths={[
          `/api/v1/accounts/${sourceRef}`,
          `/api/v1/accounts/${sourceRef}/identity`,
          `/api/v1/accounts/${sourceRef}/history`,
          `/api/v1/accounts/${sourceRef}/events`,
          `/api/v1/accounts/${sourceRef}/subnets`,
          `/api/v1/accounts/${sourceRef}/counterparties`,
          `/api/v1/accounts/${sourceRef}/stake-flow`,
          `/api/v1/accounts/${sourceRef}/serving`,
          `/api/v1/accounts/${sourceRef}/prometheus`,
        ]}
      />
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

function SectionBadge({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "accent";
}) {
  return (
    <span
      className={classNames(
        "inline-flex items-center rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em]",
        tone === "accent"
          ? "border-accent/30 bg-accent/10 text-accent"
          : "border-border bg-card text-ink-muted",
      )}
    >
      {children}
    </span>
  );
}

const TH = "px-5 py-3 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted";

function AccountFeedSectionSkeleton({
  id,
  title,
  subtitle,
  info,
}: {
  id: string;
  title: ReactNode;
  subtitle?: string;
  info?: string;
}) {
  return (
    <SectionAnchor id={id} title={title} subtitle={subtitle} info={info} tone="accent">
      <Skeleton className="h-64 w-full" />
    </SectionAnchor>
  );
}

function AccountExtrinsicsSection({
  ss58,
  rows,
  isPending,
  isError,
  error,
  onRetry,
}: {
  ss58: string;
  rows: Extrinsic[];
  isPending?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  const phase = accountFeedSectionPhase({
    isPending,
    isError,
    rowCount: rows.length,
  });
  if (phase === "skeleton") {
    return (
      <AccountFeedSectionSkeleton
        id="extrinsics"
        title="Signed extrinsics"
        info="The newest transactions this account signed, from the chain-direct extrinsics tier."
      />
    );
  }
  if (phase === "error") {
    return (
      <SectionAnchor
        id="extrinsics"
        title="Signed extrinsics"
        info="The newest transactions this account signed, from the chain-direct extrinsics tier."
        tone="accent"
      >
        <TableState
          variant="error"
          title="Couldn't load signed extrinsics"
          description="The extrinsics tier is optional enrichment — the rest of the account page is unaffected."
          error={error}
          onRetry={onRetry}
        />
      </SectionAnchor>
    );
  }
  if (phase === "empty") return null;
  return (
    <SectionAnchor
      id="extrinsics"
      title="Signed extrinsics"
      info="The newest transactions this account signed, from the chain-direct extrinsics tier."
      tone="accent"
      right={
        <div className="flex items-center gap-2">
          <SectionBadge>{formatNumber(rows.length)} rows</SectionBadge>
          <DownloadCsvButton url={buildUrl(`/api/v1/accounts/${ss58}/extrinsics`)} />
        </div>
      }
    >
      <DataPanel>
        <table className="w-full text-left text-sm">
          <thead className="bg-surface/50">
            <tr>
              <th className={TH}>Block</th>
              <th className={TH}>Call</th>
              <th className={TH}>Result</th>
              <th className={`${TH} text-right`}>Observed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((x, i) => (
              <tr
                key={x.extrinsic_hash ?? `${x.block_number}-${x.extrinsic_index}-${i}`}
                className="hover:bg-surface/30"
              >
                <td className="px-5 py-4 font-mono text-[12px]">
                  {x.block_number != null ? (
                    <Link
                      to="/blocks/$ref"
                      params={{ ref: String(x.block_number) }}
                      className="text-ink hover:text-accent hover:underline"
                    >
                      #{formatNumber(x.block_number)}
                      {x.extrinsic_index != null ? (
                        <span className="text-ink-muted">·{x.extrinsic_index}</span>
                      ) : null}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-5 py-4 font-mono text-[11px] text-ink">
                  {x.extrinsic_hash ? (
                    <Link
                      to="/extrinsics/$hash"
                      params={{ hash: x.extrinsic_hash }}
                      className="hover:text-accent hover:underline"
                    >
                      {extrinsicCall(x.call_module, x.call_function)}
                    </Link>
                  ) : (
                    extrinsicCall(x.call_module, x.call_function)
                  )}
                </td>
                <td className="px-5 py-4 font-mono text-[11px]">
                  {x.success == null ? (
                    <span className="text-ink-muted">—</span>
                  ) : x.success ? (
                    <span className="text-health-ok">ok</span>
                  ) : (
                    <span className="text-health-down">fail</span>
                  )}
                </td>
                <td className="px-5 py-4 text-right font-mono text-[11px] text-ink-muted">
                  <TimeAgo at={x.observed_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataPanel>
    </SectionAnchor>
  );
}

function AccountTransfersSection({
  ss58,
  rows,
  isPending,
  isError,
  error,
  onRetry,
}: {
  ss58: string;
  rows: Transfer[];
  isPending?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  const phase = accountFeedSectionPhase({
    isPending,
    isError,
    rowCount: rows.length,
  });
  if (phase === "skeleton") {
    return (
      <AccountFeedSectionSkeleton
        id="transfers"
        title="Transfers"
        info="Native-TAO Balances.Transfer activity for this account, directional (sent / received)."
      />
    );
  }
  if (phase === "error") {
    return (
      <SectionAnchor
        id="transfers"
        title="Transfers"
        info="Native-TAO Balances.Transfer activity for this account, directional (sent / received)."
        tone="accent"
      >
        <TableState
          variant="error"
          title="Couldn't load transfers"
          description="The transfers tier is optional enrichment — the rest of the account page is unaffected."
          error={error}
          onRetry={onRetry}
        />
      </SectionAnchor>
    );
  }
  if (phase === "empty") return null;
  return (
    <SectionAnchor
      id="transfers"
      title="Transfers"
      info="Native-TAO Balances.Transfer activity for this account, directional (sent / received)."
      tone="accent"
      right={
        <div className="flex items-center gap-2">
          <SectionBadge>{formatNumber(rows.length)} rows</SectionBadge>
          <DownloadCsvButton url={buildUrl(`/api/v1/accounts/${ss58}/transfers`)} />
        </div>
      }
    >
      <DataPanel>
        <table className="w-full text-left text-sm">
          <thead className="bg-surface/50">
            <tr>
              <th className={TH}>Block</th>
              <th className={TH}>Direction</th>
              <th className={TH}>Counterparty</th>
              <th className={`${TH} text-right`}>Amount</th>
              <th className={`${TH} text-right`}>Observed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((t, i) => {
              const counterparty = t.direction === "sent" ? t.to : t.from;
              return (
                <tr key={`${t.block_number}-${t.event_index}-${i}`} className="hover:bg-surface/30">
                  <td className="px-5 py-4 font-mono text-[12px]">
                    {t.block_number != null ? (
                      <Link
                        to="/blocks/$ref"
                        params={{ ref: String(t.block_number) }}
                        className="text-ink hover:text-accent hover:underline"
                      >
                        #{formatNumber(t.block_number)}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-5 py-4 font-mono text-[11px]">
                    {t.direction === "received" ? (
                      <span className="text-health-ok">received</span>
                    ) : t.direction === "sent" ? (
                      <span className="text-health-warn-text">sent</span>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </td>
                  <td
                    className="px-5 py-4 font-mono text-[11px] text-ink-muted"
                    title={counterparty ?? undefined}
                  >
                    {counterparty && counterparty !== ss58 ? (
                      <Link
                        to="/accounts/$ss58"
                        params={{ ss58: counterparty }}
                        className="hover:text-accent hover:underline"
                      >
                        {shortHash(counterparty)}
                      </Link>
                    ) : (
                      (shortHash(counterparty) ?? "—")
                    )}
                  </td>
                  <td className="px-5 py-4 text-right font-mono text-[11px] tabular-nums text-ink">
                    {t.amount_tao != null ? `${formatNumber(t.amount_tao)} τ` : "—"}
                  </td>
                  <td className="px-5 py-4 text-right font-mono text-[11px] text-ink-muted">
                    <TimeAgo at={t.observed_at} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DataPanel>
    </SectionAnchor>
  );
}

function fmtStake(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${formatNumber(v)} τ`;
}

// Alpha price-at-tx (#4332/6.3, #4333/6.4) -- same precision rule as
// subnet-price-ticker.tsx's priceStr, since this is the same alpha_price_tao
// unit shown there.
function fmtAlphaPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v < 0.001) return `${v.toExponential(2)} τ`;
  return `${v < 1 ? v.toFixed(4) : v.toFixed(3)} τ`;
}

const KPI_TILE = "rounded-2xl border-border/80 bg-card/95 p-5 mg-card-glow";

// Compact TAO formatter for the portfolio KPI tiles — a long raw value like
// "338,030.153 τ" wraps + overflows a narrow StatTile, so summarise it (338.0k τ).
function fmtTaoCompact(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return "0 τ";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M τ`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k τ`;
  if (v >= 1) return `${v.toFixed(2)} τ`;
  return `${v.toFixed(4)} τ`;
}

// #3491: cross-subnet portfolio for this account, from the already-shipped
// accountPortfolioQuery. An aggregate stake / emission / yield KPI row plus the
// per-subnet position table (netuid, role, stake, emission, incentive). Non-
// blocking: while it loads or if it fails, the rest of the account page is
// unaffected.
function AccountStakeMovesSection({ ss58 }: { ss58: string }) {
  const result = useQuery(accountStakeMovesQuery(ss58));
  const m = result.data?.data;

  if (result.isPending && !m) {
    return (
      <AccountFeedSectionSkeleton
        id="stake-moves"
        title="Stake moves"
        subtitle="Where this account re-delegated stake over the window: total movements, the subnets it moved across, and the per-subnet breakdown."
      />
    );
  }
  if (result.isError) {
    return (
      <SectionAnchor
        id="stake-moves"
        title="Stake moves"
        subtitle="Where this account re-delegated stake over the window: total movements, the subnets it moved across, and the per-subnet breakdown."
        tone="accent"
      >
        <TableState
          variant="error"
          title="Could not load stake moves"
          description="The stake-moves tier is optional enrichment — the rest of the account page is unaffected."
          error={result.error}
          onRetry={() => void result.refetch()}
        />
      </SectionAnchor>
    );
  }
  const subnets = m?.subnets ?? [];
  if (!m || subnets.length === 0) return null;
  const rows = [...subnets].sort((a, b) => b.movements - a.movements).slice(0, 20);

  return (
    <SectionAnchor
      id="stake-moves"
      title="Stake moves"
      subtitle="Where this account re-delegated stake over the window: total movements, the subnets it moved across, and the per-subnet breakdown."
      tone="accent"
      info="Re-delegation activity for this account, from /api/v1/accounts/{ss58}/stake-moves — total movements over the window, how concentrated they are, the dominant subnet, and the per-subnet breakdown."
      right={<SectionBadge tone="accent">{formatNumber(m.subnet_count)} subnets</SectionBadge>}
    >
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={Activity}
          eyebrow="Movements"
          tone="accent"
          value={formatNumber(m.total_movements)}
          hint={`over ${m.window}`}
          className={KPI_TILE}
        />
        <StatTile
          icon={Boxes}
          eyebrow="Subnets moved"
          value={formatNumber(m.subnet_count)}
          hint="distinct subnets"
          className={KPI_TILE}
        />
        <StatTile
          icon={Scale}
          eyebrow="Concentration"
          value={m.concentration != null ? m.concentration.toFixed(4) : "—"}
          hint="0 = spread, 1 = single"
          className={KPI_TILE}
        />
        <StatTile
          icon={Sparkles}
          eyebrow="Dominant subnet"
          value={m.dominant_netuid != null ? `SN${m.dominant_netuid}` : "—"}
          hint="most-moved"
          className={KPI_TILE}
        />
      </div>
      <DataPanel>
        <table className="w-full text-left text-sm">
          <thead className="bg-surface/50">
            <tr>
              <th className={TH}>Subnet</th>
              <th className={`${TH} text-right`}>Movements</th>
              <th className={`${TH} text-right`}>Last moved</th>
              <th className={`${TH} text-right`}>Price at last move</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((s) => (
              <tr key={s.netuid} className="hover:bg-surface/30">
                <td className="px-5 py-4 font-mono text-[12px]">
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: s.netuid }}
                    className="text-ink hover:text-accent hover:underline"
                  >
                    SN{s.netuid}
                  </Link>
                </td>
                <td className="px-5 py-4 text-right font-mono text-[12px] tabular-nums text-ink">
                  {formatNumber(s.movements)}
                </td>
                <td className="px-5 py-4 text-right font-mono text-[11px] text-ink-muted">
                  {s.last_moved_at ? <TimeAgo at={s.last_moved_at} /> : "—"}
                </td>
                <td className="px-5 py-4 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                  {fmtAlphaPrice(s.price_tao_at_last_move)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataPanel>
      {subnets.length > rows.length ? (
        <p className="mt-3 font-mono text-[10px] text-ink-muted">
          Showing the {rows.length} most-active of {formatNumber(subnets.length)} subnets.
        </p>
      ) : null}
    </SectionAnchor>
  );
}

// #3340: fund-flow leaderboard for this account — the top addresses it transacts
// with by volume, from accountCounterpartiesQuery. Self-contained + non-blocking
// (same shape as AccountStakeMovesSection): while it loads or if it fails, the
// rest of the account page is unaffected; a cold wallet renders nothing.
function AccountCounterpartiesSection({ ss58 }: { ss58: string }) {
  const result = useQuery(accountCounterpartiesQuery(ss58));
  const c = result.data?.data;
  const SUBTITLE =
    "The addresses this account transacts with most, by volume — directional totals, net flow, transfer count, and last-active block.";

  if (result.isPending && !c) {
    return (
      <AccountFeedSectionSkeleton id="counterparties" title="Counterparties" subtitle={SUBTITLE} />
    );
  }
  if (result.isError) {
    return (
      <SectionAnchor id="counterparties" title="Counterparties" subtitle={SUBTITLE} tone="accent">
        <TableState
          variant="error"
          title="Couldn't load counterparties"
          description="The counterparties tier is optional enrichment — the rest of the account page is unaffected."
          error={result.error}
          onRetry={() => void result.refetch()}
        />
      </SectionAnchor>
    );
  }
  const parties = c?.counterparties ?? [];
  if (!c || parties.length === 0) return null;
  const volume = (p: AccountCounterparty) => (p.sent_tao ?? 0) + (p.received_tao ?? 0);
  const rows = [...parties].sort((a, b) => volume(b) - volume(a)).slice(0, 20);

  return (
    <SectionAnchor
      id="counterparties"
      title="Counterparties"
      subtitle={SUBTITLE}
      tone="accent"
      info="Fund-flow leaderboard from /api/v1/accounts/{ss58}/counterparties — the top addresses by transfer volume, with sent/received/net totals and the last block each was active in."
      right={
        <SectionBadge tone="accent">{formatNumber(c.counterparty_count)} addresses</SectionBadge>
      }
    >
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={Users}
          eyebrow="Counterparties"
          tone="accent"
          value={formatNumber(c.counterparty_count)}
          hint="distinct addresses"
          className={KPI_TILE}
        />
        <StatTile
          icon={TrendingUp}
          eyebrow="Total sent"
          value={fmtTaoCompact(c.total_sent_tao)}
          hint="outflow"
          className={KPI_TILE}
        />
        <StatTile
          icon={Coins}
          eyebrow="Total received"
          value={fmtTaoCompact(c.total_received_tao)}
          hint="inflow"
          className={KPI_TILE}
        />
        <StatTile
          icon={Activity}
          eyebrow="Transfers scanned"
          value={formatNumber(c.transfers_scanned ?? 0)}
          hint={c.scan_capped ? "scan capped" : "in window"}
          className={KPI_TILE}
        />
      </div>
      <DataPanel>
        <table className="w-full text-left text-sm">
          <thead className="bg-surface/50">
            <tr>
              <th className={TH}>Address</th>
              <th className={`${TH} text-right`}>Sent</th>
              <th className={`${TH} text-right`}>Received</th>
              <th className={`${TH} text-right`}>Net flow</th>
              <th className={`${TH} text-right`}>Transfers</th>
              <th className={`${TH} text-right`}>Last block</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((p, i) => (
              <tr key={`${p.address}-${i}`} className="hover:bg-surface/30">
                <td className="px-5 py-4 font-mono text-[11px] text-ink-muted" title={p.address}>
                  {p.address !== ss58 ? (
                    <Link
                      to="/accounts/$ss58"
                      params={{ ss58: p.address }}
                      className="hover:text-accent hover:underline"
                    >
                      {shortHash(p.address)}
                    </Link>
                  ) : (
                    (shortHash(p.address) ?? "—")
                  )}
                </td>
                <td className="px-5 py-4 text-right font-mono text-[11px] tabular-nums text-ink">
                  {p.sent_tao != null ? `${formatNumber(p.sent_tao)} τ` : "—"}
                </td>
                <td className="px-5 py-4 text-right font-mono text-[11px] tabular-nums text-ink">
                  {p.received_tao != null ? `${formatNumber(p.received_tao)} τ` : "—"}
                </td>
                <td className="px-5 py-4 text-right font-mono text-[11px] tabular-nums">
                  {p.net_tao == null ? (
                    <span className="text-ink-muted">—</span>
                  ) : (
                    <span className={p.net_tao >= 0 ? "text-health-ok" : "text-health-warn-text"}>
                      {p.net_tao >= 0 ? "+" : ""}
                      {formatNumber(p.net_tao)} τ
                    </span>
                  )}
                </td>
                <td className="px-5 py-4 text-right font-mono text-[11px] tabular-nums text-ink">
                  {formatNumber(p.transfer_count ?? 0)}
                </td>
                <td className="px-5 py-4 text-right font-mono text-[12px]">
                  {p.last_block != null ? (
                    <Link
                      to="/blocks/$ref"
                      params={{ ref: String(p.last_block) }}
                      className="text-ink hover:text-accent hover:underline"
                    >
                      #{formatNumber(p.last_block)}
                    </Link>
                  ) : (
                    <span className="text-ink-muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataPanel>
      {parties.length > rows.length ? (
        <p className="mt-3 font-mono text-[10px] text-ink-muted">
          Showing the {rows.length} highest-volume of {formatNumber(parties.length)} counterparties.
        </p>
      ) : null}
    </SectionAnchor>
  );
}

const STAKE_FLOW_WINDOWS = ["7d", "30d", "90d"] as const;

// Direction label → tone, reusing the health-ok/warn/muted convention the
// transfers section uses for sent/received direction. `exiting` and `churning`
// were amber-500 vs amber-400 -- a shade split the health-* scale doesn't carry,
// so both land on the single warn tone; the branches stay as they are because the
// tone is the only thing this maps.
function stakeFlowDirClass(dir: string | null | undefined): string {
  if (dir === "accumulating") return "text-health-ok";
  if (dir === "exiting") return "text-health-warn-text";
  if (dir === "churning") return "text-health-warn-text";
  return "text-ink-muted"; // idle / unknown
}

// #3341: per-account staking-behavior scorecard — net vs gross flow, a direction
// label, and the per-subnet stake/unstake breakdown over a selectable window,
// from accountStakeFlowQuery. Self-contained + non-blocking (same shape as the
// sibling subnet-breakdown sections); the window control is section-local state.
function AccountStakeFlowSection({ ss58 }: { ss58: string }) {
  const [window, setWindow] = useState<(typeof STAKE_FLOW_WINDOWS)[number]>("30d");
  const result = useQuery(accountStakeFlowQuery(ss58, { window }));
  const f = result.data?.data;
  const SUBTITLE =
    "Net staking direction and per-subnet stake / unstake flow for this account over the selected window.";
  const windowControl = (
    <SelectFilter
      label="Window"
      value={window}
      onChange={(v) =>
        setWindow((STAKE_FLOW_WINDOWS as readonly string[]).includes(v) ? (v as never) : "30d")
      }
      options={STAKE_FLOW_WINDOWS.map((w) => ({ value: w, label: w }))}
    />
  );

  if (result.isPending && !f) {
    return <AccountFeedSectionSkeleton id="stake-flow" title="Stake flow" subtitle={SUBTITLE} />;
  }
  if (result.isError) {
    return (
      <SectionAnchor
        id="stake-flow"
        title="Stake flow"
        subtitle={SUBTITLE}
        tone="accent"
        right={windowControl}
      >
        <TableState
          variant="error"
          title="Couldn't load stake flow"
          description="The stake-flow tier is optional enrichment — the rest of the account page is unaffected."
          error={result.error}
          onRetry={() => void result.refetch()}
        />
      </SectionAnchor>
    );
  }

  const subnets: AccountStakeFlowSubnet[] = f?.subnets ?? [];
  const netFlow = f?.net_flow_tao ?? null;
  const netStr =
    netFlow == null ? "—" : `${netFlow >= 0 ? "+" : "−"}${fmtTaoCompact(Math.abs(netFlow))}`;
  // BarMini widths are unsigned (value / cap), so bar the always-≥0 gross flow
  // and surface each row's direction as a label in the table alongside.
  const bars = [...subnets]
    .filter((s) => (s.gross_flow_tao ?? 0) > 0)
    .sort((a, b) => (b.gross_flow_tao ?? 0) - (a.gross_flow_tao ?? 0))
    .slice(0, 12)
    .map((s) => ({ label: `SN${s.netuid}`, value: s.gross_flow_tao ?? 0 }));

  return (
    <SectionAnchor
      id="stake-flow"
      title="Stake flow"
      subtitle={SUBTITLE}
      tone="accent"
      info="Per-account staking behavior from /api/v1/accounts/{ss58}/stake-flow — net vs gross TAO flow, a direction label (accumulating / exiting / churning / idle), concentration, and the per-subnet stake / unstake breakdown over the window."
      right={windowControl}
    >
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={TrendingUp}
          eyebrow="Net flow"
          tone="accent"
          value={
            <span
              className={
                netFlow != null && netFlow < 0 ? "text-health-warn-text" : "text-health-ok"
              }
            >
              {netStr}
            </span>
          }
          hint={`over ${f?.window ?? window}`}
          className={KPI_TILE}
        />
        <StatTile
          icon={Activity}
          eyebrow="Gross flow"
          value={fmtTaoCompact(f?.gross_flow_tao)}
          hint="staked + unstaked"
          className={KPI_TILE}
        />
        <StatTile
          icon={Gauge}
          eyebrow="Direction"
          value={<span className={stakeFlowDirClass(f?.direction)}>{f?.direction ?? "—"}</span>}
          hint={
            f?.concentration != null
              ? `${(f.concentration * 100).toFixed(0)}% concentrated`
              : undefined
          }
          className={KPI_TILE}
        />
        <StatTile
          icon={Boxes}
          eyebrow="Dominant subnet"
          value={
            f?.dominant_netuid != null ? (
              <Link
                to="/subnets/$netuid"
                params={{ netuid: f.dominant_netuid }}
                className="text-ink-strong hover:text-accent hover:underline"
              >
                SN{f.dominant_netuid}
              </Link>
            ) : (
              "—"
            )
          }
          hint={`${formatNumber(f?.subnet_count ?? 0)} subnets`}
          className={KPI_TILE}
        />
      </div>

      {bars.length > 0 ? (
        <div className="mb-5 rounded-2xl border border-border/80 bg-card/95 px-5 py-4 mg-card-glow">
          <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            gross flow by subnet (τ)
          </div>
          <BarMini data={bars} showValue={false} />
        </div>
      ) : null}

      {subnets.length > 0 ? (
        <DataPanel>
          <table className="w-full text-left text-sm">
            <thead className="bg-surface/50">
              <tr>
                <th className={TH}>Subnet</th>
                <th className={TH}>Direction</th>
                <th className={`${TH} text-right`}>Net flow</th>
                <th className={`${TH} text-right`}>Gross flow</th>
                <th className={`${TH} text-right`}>Events</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...subnets]
                .sort((a, b) => (b.gross_flow_tao ?? 0) - (a.gross_flow_tao ?? 0))
                .slice(0, 20)
                .map((s) => (
                  <tr key={s.netuid} className="hover:bg-surface/30">
                    <td className="px-5 py-4 font-mono text-[12px]">
                      <Link
                        to="/subnets/$netuid"
                        params={{ netuid: s.netuid }}
                        className="text-ink hover:text-accent hover:underline"
                      >
                        SN{s.netuid}
                      </Link>
                    </td>
                    <td className="px-5 py-4 font-mono text-[11px]">
                      <span className={stakeFlowDirClass(s.direction)}>{s.direction ?? "—"}</span>
                    </td>
                    <td className="px-5 py-4 text-right font-mono text-[11px] tabular-nums">
                      {s.net_flow_tao == null ? (
                        <span className="text-ink-muted">—</span>
                      ) : (
                        <span
                          className={
                            s.net_flow_tao >= 0 ? "text-health-ok" : "text-health-warn-text"
                          }
                        >
                          {s.net_flow_tao >= 0 ? "+" : "−"}
                          {fmtStake(Math.abs(s.net_flow_tao))}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-right font-mono text-[11px] tabular-nums text-ink">
                      {fmtStake(s.gross_flow_tao)}
                    </td>
                    <td className="px-5 py-4 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                      {formatNumber((s.stake_events ?? 0) + (s.unstake_events ?? 0))}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </DataPanel>
      ) : (
        <p className="rounded-2xl border border-border/80 bg-card/95 px-5 py-4 font-mono text-[11px] text-ink-muted">
          No stake or unstake flow recorded for this account over the {f?.window ?? window} window.
        </p>
      )}
    </SectionAnchor>
  );
}

function AccountPortfolioSection({ ss58 }: { ss58: string }) {
  const result = useQuery(accountPortfolioQuery(ss58));
  const p = result.data?.data;
  // Per-position drill-down (#4329/6.4 -- the "Alpha Holdings chart"): each
  // row expands in place rather than navigating away, so a viewer can compare
  // several positions' history without losing the portfolio table.
  const [expandedNetuid, setExpandedNetuid] = useState<number | null>(null);

  if (result.isPending && !p) {
    return (
      <AccountFeedSectionSkeleton
        id="portfolio"
        title="Portfolio"
        subtitle="Cross-subnet neuron positions for this account: per-subnet stake, emission, and role, with an aggregate stake and yield summary."
      />
    );
  }
  if (result.isError) {
    return (
      <SectionAnchor
        id="portfolio"
        title="Portfolio"
        subtitle="Cross-subnet neuron positions for this account: per-subnet stake, emission, and role, with an aggregate stake and yield summary."
        tone="accent"
      >
        <TableState
          variant="error"
          title="Could not load portfolio"
          description="The portfolio tier is optional enrichment — the rest of the account page is unaffected."
          error={result.error}
          onRetry={() => void result.refetch()}
        />
      </SectionAnchor>
    );
  }
  const positions = p?.positions ?? [];
  if (!p || positions.length === 0) return null;

  return (
    <SectionAnchor
      id="portfolio"
      title="Portfolio"
      subtitle="Cross-subnet neuron positions for this account: per-subnet stake, emission, and role, with an aggregate stake and yield summary."
      tone="accent"
      info="The account's registered neurons across every subnet, from /api/v1/accounts/{ss58}/portfolio — total stake and emission, the validator / miner split, and the per-subnet breakdown."
      right={<SectionBadge tone="accent">{formatNumber(p.subnet_count)} subnets</SectionBadge>}
    >
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={Boxes}
          eyebrow="Positions"
          tone="accent"
          value={formatNumber(p.position_count)}
          hint={`across ${formatNumber(p.subnet_count)} subnets`}
          className={KPI_TILE}
        />
        <StatTile
          icon={Coins}
          eyebrow="Total stake"
          value={fmtTaoCompact(p.total_stake_tao)}
          hint={`${formatNumber(p.validator_count)} val / ${formatNumber(p.miner_count)} min`}
          className={KPI_TILE}
        />
        <StatTile
          icon={Sparkles}
          eyebrow="Total emission"
          value={fmtTaoCompact(p.total_emission_tao)}
          hint="summed across positions"
          className={KPI_TILE}
        />
        <StatTile
          icon={TrendingUp}
          eyebrow="Overall yield"
          value={p.overall_yield != null ? p.overall_yield.toExponential(2) : "—"}
          hint="return rate"
          className={KPI_TILE}
        />
      </div>
      <DataPanel>
        <table className="w-full text-left text-sm">
          <thead className="bg-surface/50">
            <tr>
              <th className={TH} aria-hidden="true" />
              <th className={TH}>Subnet</th>
              <th className={TH}>Role</th>
              <th className={`${TH} text-right`}>Stake</th>
              <th className={`${TH} text-right`}>Emission</th>
              <th className={`${TH} text-right`}>Incentive</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {positions.map((pos) => {
              const expanded = expandedNetuid === pos.netuid;
              return (
                <Fragment key={`${pos.netuid}-${pos.uid ?? "x"}`}>
                  <tr className="hover:bg-surface/30">
                    <td className="px-3 py-4">
                      <button
                        type="button"
                        onClick={() => setExpandedNetuid(expanded ? null : pos.netuid)}
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Hide" : "Show"} SN${pos.netuid} position history`}
                        className="flex size-5 items-center justify-center rounded text-ink-muted hover:text-ink-strong"
                      >
                        <ChevronDown
                          className={classNames(
                            "size-3.5 transition-transform",
                            expanded ? "rotate-180" : "",
                          )}
                        />
                      </button>
                    </td>
                    <td className="px-5 py-4 font-mono text-[12px]">
                      <Link
                        to="/subnets/$netuid"
                        params={{ netuid: pos.netuid }}
                        className="text-ink hover:text-accent hover:underline"
                      >
                        SN{pos.netuid}
                      </Link>
                    </td>
                    <td className="px-5 py-4 font-mono text-[11px]">
                      {pos.role === "validator" ? (
                        <span className="text-health-ok">validator</span>
                      ) : pos.role === "miner" ? (
                        <span className="text-chart-1">miner</span>
                      ) : (
                        <span className="text-ink-muted">{"—"}</span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-right font-mono text-[11px] tabular-nums text-ink">
                      {fmtStake(pos.stake_tao)}
                    </td>
                    <td className="px-5 py-4 text-right font-mono text-[11px] tabular-nums text-ink">
                      {fmtStake(pos.emission_tao)}
                    </td>
                    <td className="px-5 py-4 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                      {pos.incentive != null ? pos.incentive.toFixed(4) : "—"}
                    </td>
                  </tr>
                  {expanded ? (
                    <tr className="bg-surface/20">
                      <td colSpan={6} className="px-5 py-4">
                        <AccountPositionHistoryChart ss58={ss58} netuid={pos.netuid} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </DataPanel>
    </SectionAnchor>
  );
}

// #4324/5.1: personal (coldkey) on-chain identity for this account, from a
// set_identity call — distinct from subnet identity and from the validator
// directory's coldkey-identity join. has_identity is false for the common
// case (most accounts never set one), so the section renders nothing rather
// than an empty card. Non-blocking: while it loads or if it fails, the rest
// of the account page is unaffected.
function AccountIdentitySection({ ss58 }: { ss58: string }) {
  const result = useQuery(accountIdentityQuery(ss58));
  const identity = result.data?.data;
  const SUBTITLE = "On-chain personal identity this account registered via set_identity.";

  if (result.isPending && !identity) {
    return <AccountFeedSectionSkeleton id="identity" title="Identity" subtitle={SUBTITLE} />;
  }
  if (result.isError) {
    return (
      <SectionAnchor id="identity" title="Identity" subtitle={SUBTITLE} tone="accent">
        <TableState
          variant="error"
          title="Could not load identity"
          description="The identity tier is optional enrichment — the rest of the account page is unaffected."
          error={result.error}
          onRetry={() => void result.refetch()}
        />
      </SectionAnchor>
    );
  }
  if (!identity || !identity.has_identity) return null;

  return (
    <SectionAnchor
      id="identity"
      title="Identity"
      subtitle={SUBTITLE}
      tone="accent"
      info="GET /api/v1/accounts/{ss58}/identity — the coldkey's own on-chain identity, distinct from subnet identity and the validator directory's coldkey-identity join."
    >
      <div className="rounded-2xl border border-border/80 bg-card/95 p-5 mg-card-glow">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-display text-lg font-semibold text-ink-strong">
            {identity.name ?? "Unnamed identity"}
          </span>
          {identity.captured_at ? (
            <span className="font-mono text-[11px] text-ink-muted">
              captured <TimeAgo at={identity.captured_at} />
            </span>
          ) : null}
        </div>
        {identity.description ? (
          <p className="mt-2 text-sm text-ink-muted">{identity.description}</p>
        ) : null}
        {identity.url || identity.github || identity.discord || identity.image ? (
          <div className="mt-3 flex flex-wrap gap-3 text-[11px]">
            {identity.url ? (
              <ExternalLink href={identity.url} className="text-accent-text hover:underline">
                <Globe className="size-3.5 shrink-0" aria-hidden /> website
              </ExternalLink>
            ) : null}
            {identity.github ? (
              <ExternalLink href={identity.github} className="text-accent-text hover:underline">
                <Github className="size-3.5 shrink-0" aria-hidden /> github
              </ExternalLink>
            ) : null}
            {identity.image ? (
              <ExternalLink href={identity.image} className="text-accent-text hover:underline">
                image
              </ExternalLink>
            ) : null}
            {identity.discord ? (
              <span className="inline-flex items-center gap-1 text-ink-muted">
                <MessageCircle className="size-3.5 shrink-0" aria-hidden />
                {identity.discord}
              </span>
            ) : null}
          </div>
        ) : null}
        {identity.additional ? (
          <p className="mt-2 font-mono text-[11px] text-ink-muted">{identity.additional}</p>
        ) : null}
      </div>
    </SectionAnchor>
  );
}

/**
 * Axon-removal (teardown) footprint over the trailing 30-day window — a flat
 * count + distinct-subnet summary from /axon-removals. Non-blocking: while the
 * dedicated query loads (or if it fails), the section never stalls the page.
 */
function AccountTeardownActivitySection({ ss58 }: { ss58: string }) {
  const result = useQuery(accountAxonRemovalsQuery(ss58));
  const card = result.data?.data;
  const windowLabel = card?.window ?? "30d";

  if (result.isPending && !card) {
    return (
      <AccountFeedSectionSkeleton
        id="teardown"
        title="Teardown activity"
        subtitle={`Axon endpoint removals (AxonInfoRemoved) for this account over the trailing ${windowLabel} window.`}
      />
    );
  }

  if (result.isError) {
    return (
      <SectionAnchor
        id="teardown"
        title="Teardown activity"
        subtitle={`Axon endpoint removals (AxonInfoRemoved) for this account over the trailing ${windowLabel} window.`}
        tone="accent"
      >
        <TableState
          variant="error"
          title="Could not load teardown activity"
          description="The axon-removals tier is optional enrichment — the rest of the account page is unaffected."
          error={result.error}
          onRetry={() => void result.refetch()}
        />
      </SectionAnchor>
    );
  }

  const removals = card?.total_removals ?? 0;
  const distinctSubnets = card?.subnet_count ?? 0;
  if (removals === 0 && distinctSubnets === 0) return null;

  return (
    <SectionAnchor
      id="teardown"
      title="Teardown activity"
      subtitle={`Axon endpoint removals (AxonInfoRemoved) for this account over the trailing ${windowLabel} window.`}
      tone="accent"
      info="The account-level companion to subnet axon-removal activity — counts how often this hotkey removed an announced axon endpoint, and on how many distinct subnets."
      right={<SectionBadge tone="accent">{windowLabel}</SectionBadge>}
    >
      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <StatTile
          icon={Unplug}
          eyebrow="Removals"
          tone="accent"
          value={formatNumber(removals)}
          hint={`AxonInfoRemoved · ${windowLabel}`}
          className={KPI_TILE}
        />
        <StatTile
          icon={Boxes}
          eyebrow="Distinct subnets"
          value={formatNumber(distinctSubnets)}
          hint="subnets with teardown"
          className={KPI_TILE}
        />
      </div>
    </SectionAnchor>
  );
}

/**
 * Deregistration (eviction) footprint over the trailing 30-day window — a flat
 * count + distinct-subnet summary from /deregistrations. Non-blocking: while the
 * dedicated query loads (or if it fails), the section never stalls the page.
 */
function AccountRegistrationActivitySection({ ss58 }: { ss58: string }) {
  const result = useQuery(accountRegistrationsQuery(ss58));
  const card = result.data?.data;
  const windowLabel = card?.window ?? "30d";

  if (result.isPending && !card) {
    return (
      <AccountFeedSectionSkeleton
        id="registrations"
        title="Registration activity"
        subtitle={`Neuron registrations (NeuronRegistered) for this account over the trailing ${windowLabel} window.`}
      />
    );
  }

  if (result.isError) {
    return (
      <SectionAnchor
        id="registrations"
        title="Registration activity"
        subtitle={`Neuron registrations (NeuronRegistered) for this account over the trailing ${windowLabel} window.`}
        tone="accent"
      >
        <TableState
          variant="error"
          title="Could not load registration activity"
          description="The registrations tier is optional enrichment — the rest of the account page is unaffected."
          error={result.error}
          onRetry={() => void result.refetch()}
        />
      </SectionAnchor>
    );
  }

  const registrations = card?.total_registrations ?? 0;
  const distinctSubnets = card?.subnet_count ?? 0;
  if (registrations === 0 && distinctSubnets === 0) return null;

  return (
    <SectionAnchor
      id="registrations"
      title="Registration activity"
      subtitle={`Neuron registrations (NeuronRegistered) for this account over the trailing ${windowLabel} window.`}
      tone="accent"
      info="The account-level companion to subnet registration activity — counts how often this hotkey was registered into a subnet, and on how many distinct subnets."
      right={<SectionBadge tone="accent">{windowLabel}</SectionBadge>}
    >
      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <StatTile
          icon={UserPlus}
          eyebrow="Registrations"
          tone="accent"
          value={formatNumber(registrations)}
          hint={`NeuronRegistered · ${windowLabel}`}
          className={KPI_TILE}
        />
        <StatTile
          icon={Boxes}
          eyebrow="Distinct subnets"
          value={formatNumber(distinctSubnets)}
          hint="subnets with registration"
          className={KPI_TILE}
        />
      </div>
    </SectionAnchor>
  );
}

function AccountDeregistrationActivitySection({ ss58 }: { ss58: string }) {
  const result = useQuery(accountDeregistrationsQuery(ss58));
  const card = result.data?.data;
  const windowLabel = card?.window ?? "30d";

  if (result.isPending && !card) {
    return (
      <AccountFeedSectionSkeleton
        id="deregistrations"
        title="Deregistration activity"
        subtitle={`Neuron deregistrations (NeuronDeregistered) for this account over the trailing ${windowLabel} window.`}
      />
    );
  }

  if (result.isError) {
    return (
      <SectionAnchor
        id="deregistrations"
        title="Deregistration activity"
        subtitle={`Neuron deregistrations (NeuronDeregistered) for this account over the trailing ${windowLabel} window.`}
        tone="accent"
      >
        <TableState
          variant="error"
          title="Could not load deregistration activity"
          description="The deregistrations tier is optional enrichment — the rest of the account page is unaffected."
          error={result.error}
          onRetry={() => void result.refetch()}
        />
      </SectionAnchor>
    );
  }

  const deregistrations = card?.total_deregistrations ?? 0;
  const distinctSubnets = card?.subnet_count ?? 0;
  if (deregistrations === 0 && distinctSubnets === 0) return null;

  return (
    <SectionAnchor
      id="deregistrations"
      title="Deregistration activity"
      subtitle={`Neuron deregistrations (NeuronDeregistered) for this account over the trailing ${windowLabel} window.`}
      tone="accent"
      info="The account-level companion to subnet deregistration activity — counts how often this hotkey was deregistered (evicted) from a subnet, and on how many distinct subnets."
      right={<SectionBadge tone="accent">{windowLabel}</SectionBadge>}
    >
      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <StatTile
          icon={UserMinus}
          eyebrow="Deregistrations"
          tone="accent"
          value={formatNumber(deregistrations)}
          hint={`NeuronDeregistered · ${windowLabel}`}
          className={KPI_TILE}
        />
        <StatTile
          icon={Boxes}
          eyebrow="Distinct subnets"
          value={formatNumber(distinctSubnets)}
          hint="subnets with deregistration"
          className={KPI_TILE}
        />
      </div>
    </SectionAnchor>
  );
}

/**
 * Validator weight-setting (WeightsSet) footprint over the trailing 30-day
 * window — KPI summary + per-subnet breakdown from /weight-setters. Unlike
 * teardown, always renders: zero activity shows an empty state (typical for
 * non-validator hotkeys), not a hidden section or an error.
 */
function AccountWeightSettingSection({ ss58 }: { ss58: string }) {
  const result = useQuery(accountWeightSettersQuery(ss58));
  const card = result.data?.data;
  const windowLabel = card?.window ?? "30d";
  const subnets = card?.subnets ?? [];
  const totalSets = card?.total_weight_sets ?? 0;

  if (result.isPending && !card) {
    return (
      <AccountFeedSectionSkeleton
        id="weight-setting"
        title="Weight-setting activity"
        subtitle={`Validator WeightsSet events for this account over the trailing ${windowLabel} window.`}
      />
    );
  }

  if (result.isError) {
    return (
      <SectionAnchor
        id="weight-setting"
        title="Weight-setting activity"
        subtitle={`Validator WeightsSet events for this account over the trailing ${windowLabel} window.`}
        tone="accent"
      >
        <TableState
          variant="error"
          title="Could not load weight-setting activity"
          description="The weight-setters tier is optional enrichment — the rest of the account page is unaffected."
          error={result.error}
          onRetry={() => void result.refetch()}
        />
      </SectionAnchor>
    );
  }

  return (
    <SectionAnchor
      id="weight-setting"
      title="Weight-setting activity"
      subtitle={`Validator WeightsSet events for this account over the trailing ${windowLabel} window — per-subnet breakdown when this hotkey submits weights.`}
      tone="accent"
      info="The account-level companion to subnet weight-setter leaderboards — keyed on the validator hotkey submitting its weight vector."
      right={<SectionBadge tone="accent">{windowLabel}</SectionBadge>}
    >
      {totalSets === 0 && subnets.length === 0 ? (
        <TableState
          variant="empty"
          title="No weight-setting activity"
          description="This account has not submitted WeightsSet events in the trailing window — typical for non-validator hotkeys or coldkey-only addresses."
        />
      ) : (
        <>
          <div className="mb-5 grid max-w-2xl gap-4 sm:grid-cols-2">
            <StatTile
              icon={Scale}
              eyebrow="Weight sets"
              tone="accent"
              value={formatNumber(totalSets)}
              hint={`WeightsSet · ${windowLabel}`}
              className={KPI_TILE}
            />
            <StatTile
              icon={Boxes}
              eyebrow="Distinct subnets"
              value={formatNumber(card?.subnet_count ?? subnets.length)}
              hint="subnets with weight sets"
              className={KPI_TILE}
            />
          </div>
          <DataPanel>
            <table className="w-full text-left text-sm">
              <thead className="bg-surface/50">
                <tr>
                  <th className={TH}>Subnet</th>
                  <th className={`${TH} text-right`}>Weight sets</th>
                  <th className={`${TH} text-right`}>Last set</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {subnets.map((row) => (
                  <tr key={row.netuid} className="hover:bg-surface/30">
                    <td className="px-5 py-4 font-mono text-[12px]">
                      <Link
                        to="/subnets/$netuid"
                        params={{ netuid: row.netuid }}
                        className="inline-flex items-center rounded-full border border-border bg-paper px-2.5 py-1 font-medium text-ink-strong transition-colors hover:border-accent/30 hover:text-accent"
                      >
                        SN{row.netuid}
                      </Link>
                    </td>
                    <td className="px-5 py-4 text-right font-mono text-[12px] tabular-nums text-ink">
                      {formatNumber(row.weight_sets)}
                    </td>
                    <td className="px-5 py-4 text-right font-mono text-[11px] text-ink-muted">
                      <TimeAgo at={row.last_set_at ?? undefined} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataPanel>
        </>
      )}
    </SectionAnchor>
  );
}

/**
 * Axon + Prometheus endpoint announcement footprint over the trailing 30-day
 * window — a combined serving/Prometheus summary from /serving and /prometheus.
 * Non-blocking: shows a graceful empty state when the account announced no
 * endpoints (typical for non-miner accounts).
 */
// #3938: the "Endpoint announcements" heading is a few characters longer than
// its "Teardown activity" sibling and, with the section header's wide tracking,
// wrapped to two lines at the 375px mobile width. Tighten the tracking a step on
// mobile so it stays on one line, restoring the default wider tracking from the
// sm breakpoint up (tablet/desktop are unchanged).
const endpointAnnouncementsTitle = (
  <span className="tracking-normal sm:tracking-wider">Endpoint announcements</span>
);

function AccountEndpointAnnouncementSection({ ss58 }: { ss58: string }) {
  const servingResult = useQuery(accountServingQuery(ss58));
  const prometheusResult = useQuery(accountPrometheusQuery(ss58));
  const serving = servingResult.data?.data;
  const prometheus = prometheusResult.data?.data;
  const windowLabel = serving?.window ?? prometheus?.window ?? "30d";

  const pending =
    (servingResult.isPending && !serving) || (prometheusResult.isPending && !prometheus);
  const bothError = servingResult.isError && prometheusResult.isError && !serving && !prometheus;

  if (pending) {
    return (
      <AccountFeedSectionSkeleton
        id="endpoint-announcements"
        title={endpointAnnouncementsTitle}
        subtitle={`Axon endpoint (AxonServed) and Prometheus telemetry (PrometheusServed) announcements for this account over the trailing ${windowLabel} window.`}
      />
    );
  }

  if (bothError) {
    return (
      <SectionAnchor
        id="endpoint-announcements"
        title={endpointAnnouncementsTitle}
        subtitle={`Axon endpoint (AxonServed) and Prometheus telemetry (PrometheusServed) announcements for this account over the trailing ${windowLabel} window.`}
        tone="accent"
      >
        <TableState
          variant="error"
          title="Could not load endpoint announcement activity"
          description="The serving and prometheus tiers are optional enrichment — the rest of the account page is unaffected."
          error={servingResult.error ?? prometheusResult.error}
          onRetry={() => {
            void servingResult.refetch();
            void prometheusResult.refetch();
          }}
        />
      </SectionAnchor>
    );
  }

  // Each source can fail independently while the other succeeds — the
  // combined section must not render the failed half's count as if it were
  // a genuine zero.
  const servingFailed = servingResult.isError && !serving;
  const prometheusFailed = prometheusResult.isError && !prometheus;
  const servingCount = serving?.total_announcements ?? 0;
  const prometheusCount = prometheus?.total_announcements ?? 0;
  const isEmpty =
    !servingFailed && !prometheusFailed && servingCount === 0 && prometheusCount === 0;

  return (
    <SectionAnchor
      id="endpoint-announcements"
      title={endpointAnnouncementsTitle}
      subtitle={`Axon endpoint (AxonServed) and Prometheus telemetry (PrometheusServed) announcements for this account over the trailing ${windowLabel} window.`}
      tone="accent"
      info="The account-level companion to subnet serving + prometheus activity — counts how often this hotkey announced axon and Prometheus endpoints."
      right={<SectionBadge tone="accent">{windowLabel}</SectionBadge>}
    >
      {isEmpty ? (
        <EmptyState
          title="No endpoint announcements"
          description="This account had no AxonServed or PrometheusServed events in the window — typical for non-miner accounts or coldkeys without serving activity."
        />
      ) : (
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <StatTile
            icon={Radar}
            eyebrow="Axon serving"
            tone={servingFailed ? "warn" : "accent"}
            value={servingFailed ? "—" : formatNumber(servingCount)}
            hint={
              servingFailed
                ? "fetch failed · showing Prometheus only"
                : `AxonServed · ${windowLabel}`
            }
            className={KPI_TILE}
          />
          <StatTile
            icon={Gauge}
            eyebrow="Prometheus"
            tone={prometheusFailed ? "warn" : "default"}
            value={prometheusFailed ? "—" : formatNumber(prometheusCount)}
            hint={
              prometheusFailed
                ? "fetch failed · showing Axon only"
                : `PrometheusServed · ${windowLabel}`
            }
            className={KPI_TILE}
          />
        </div>
      )}
    </SectionAnchor>
  );
}

/**
 * Cross-subnet footprint (#266) — the dedicated netuid-ordered /subnets feed
 * plus a stake-by-subnet BarMini. Non-blocking: while the dedicated query loads
 * (or if it fails), the already-fetched summary registrations are the fallback,
 * so the section never stalls or disappears.
 */
function AccountFootprintSection({
  ss58,
  fallback,
}: {
  ss58: string;
  fallback: AccountRegistration[];
}) {
  const subnetsResult = useQuery(accountSubnetsQuery(ss58));
  const rows = subnetsResult.data?.data.subnets ?? fallback;

  // Keep this optional enrichment non-blocking: fallback registrations should
  // render while the dedicated subnet feed is pending or has failed.
  const phase = accountFeedSectionPhase({
    isPending: subnetsResult.isPending,
    isError: subnetsResult.isError,
    rowCount: rows.length,
    preferErrorWithRows: false,
  });
  if (phase === "skeleton") {
    return (
      <AccountFeedSectionSkeleton
        id="footprint"
        title="Subnet footprint"
        subtitle="Current registrations across the indexed network, netuid-ordered, with stake distribution."
      />
    );
  }
  if (phase === "error") {
    return (
      <SectionAnchor
        id="footprint"
        title="Subnet footprint"
        subtitle="Current registrations across the indexed network, netuid-ordered, with stake distribution."
        tone="accent"
      >
        <TableState
          variant="error"
          title="Could not load subnet footprint"
          description="The account's cross-subnet registrations could not be loaded."
          error={subnetsResult.error}
          onRetry={() => void subnetsResult.refetch()}
        />
      </SectionAnchor>
    );
  }
  if (rows.length === 0) return null;

  const staked = rows
    .filter((r) => r.netuid != null && (r.stake_tao ?? 0) > 0)
    .slice(0, 12)
    .map((r) => ({ label: `SN${r.netuid}`, value: r.stake_tao ?? 0 }));

  return (
    <SectionAnchor
      id="footprint"
      title="Subnet footprint"
      subtitle="Current registrations across the indexed network, netuid-ordered, with stake distribution."
      tone="accent"
      right={<SectionBadge>{formatNumber(rows.length)} subnets</SectionBadge>}
    >
      {staked.length > 0 ? (
        <div className="mb-5 rounded-2xl border border-border/80 bg-card/95 px-5 py-4 mg-card-glow">
          <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            stake by subnet (τ)
          </div>
          <BarMini data={staked} showValue={false} />
        </div>
      ) : null}
      {/* #6428: five columns at `px-5` do not fit a 375px viewport, so Permit
          and Active -- and with them this section's only route to a validator
          profile -- sit outside the scroll viewport on mobile. Desktop keeps
          the table; mobile gets the card fallback endpoint-list.tsx uses for
          the same problem, so every field (and the permit link) is reachable
          without a horizontal swipe. */}
      <DataPanel className="hidden md:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface/50">
            <tr>
              <th className={TH}>Subnet</th>
              <th className={`${TH} text-right`}>UID</th>
              <th className={`${TH} text-right`}>Stake</th>
              <th className={TH}>Permit</th>
              <th className={TH}>Active</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={`${r.netuid}-${r.uid}`} className="hover:bg-surface/30">
                <td className="px-5 py-4 font-mono text-[12px]">
                  {r.netuid != null ? (
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: r.netuid }}
                      // Same deep-link as SubnetPerformanceTable: this row already
                      // knows its uid, so land on the neuron card, not the overview.
                      search={subnetPositionSearch(r.uid)}
                      className="inline-flex items-center rounded-full border border-border bg-paper px-2.5 py-1 font-medium text-ink-strong transition-colors hover:border-accent/30 hover:text-accent"
                    >
                      SN{r.netuid}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-5 py-4 text-right font-mono text-[12px] tabular-nums text-ink">
                  {r.uid != null ? formatNumber(r.uid) : "—"}
                </td>
                <td className="px-5 py-4 text-right font-mono text-[12px] tabular-nums text-ink">
                  {fmtStake(r.stake_tao)}
                </td>
                <td className="px-5 py-4 font-mono text-[11px]">
                  {r.validator_permit ? (
                    <ValidatorPermitBadge ss58={ss58} />
                  ) : (
                    <span className="text-ink-muted">—</span>
                  )}
                </td>
                <td className="px-5 py-4 font-mono text-[11px]">
                  {r.active ? (
                    <span className="inline-flex rounded-full bg-health-ok/10 px-2 py-0.5 text-health-ok">
                      active
                    </span>
                  ) : (
                    <span className="inline-flex rounded-full bg-surface px-2 py-0.5 text-ink-muted">
                      idle
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataPanel>

      <ul className="space-y-2 md:hidden">
        {rows.map((r) => (
          <li key={`${r.netuid}-${r.uid}`} className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                {r.netuid != null ? (
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: r.netuid }}
                    className="inline-flex items-center rounded-full border border-border bg-paper px-2.5 py-1 font-mono text-[12px] font-medium text-ink-strong transition-colors hover:border-accent/30 hover:text-accent"
                  >
                    SN{r.netuid}
                  </Link>
                ) : (
                  <span className="font-mono text-[12px] text-ink-muted">—</span>
                )}
                {r.validator_permit ? <ValidatorPermitBadge ss58={ss58} /> : null}
              </div>
              {r.active ? (
                <span className="inline-flex shrink-0 rounded-full bg-health-ok/10 px-2 py-0.5 font-mono text-[11px] text-health-ok">
                  active
                </span>
              ) : (
                <span className="inline-flex shrink-0 rounded-full bg-surface px-2 py-0.5 font-mono text-[11px] text-ink-muted">
                  idle
                </span>
              )}
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border pt-2 text-[11px]">
              <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                UID
              </dt>
              <dd className="text-right font-mono tabular-nums text-ink">
                {r.uid != null ? formatNumber(r.uid) : "—"}
              </dd>
              <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Stake
              </dt>
              <dd className="text-right font-mono tabular-nums text-ink">
                {fmtStake(r.stake_tao)}
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </SectionAnchor>
  );
}

/**
 * The "validator" permit badge (#6428) — links to this account's own validator
 * profile, the page carrying its stake, nominators, APY, and cross-subnet
 * performance. Shared by the desktop table and the mobile cards so the two can
 * never drift.
 *
 * `validator_permit` is a per-UID metagraph property keyed by hotkey, so an
 * ss58 the subnets feed reports a permit for is registered as that subnet's
 * validator hotkey and `/validators/{ss58}` resolves. A coldkey-only address
 * never carries a permit, so the caller's existing `validator_permit` gate is
 * also what keeps this link off those pages.
 */
function ValidatorPermitBadge({ ss58 }: { ss58: string }) {
  return (
    <Link
      to="/validators/$hotkey"
      params={{ hotkey: ss58 }}
      title={`Validator profile for ${ss58}`}
      className="inline-flex shrink-0 rounded-full bg-health-ok/10 px-2 py-0.5 font-mono text-[11px] text-health-ok transition-colors hover:bg-health-ok/20"
    >
      validator
    </Link>
  );
}

/**
 * Paginated first-party chain-event feed (#266) — the full /events superset of
 * the summary's recent-events sample, with a ?kind filter (options derived from
 * the already-fetched event_kinds) and offset pagination matching the sibling
 * /extrinsics + /transfers feeds (a full page implies more; a short page is the
 * tail). Non-blocking so a slow tier never stalls the page.
 */
function AccountEventsSection({
  ss58,
  kindOptions,
}: {
  ss58: string;
  kindOptions: AccountSummary["event_kinds"];
}) {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const limit = search.ev_limit ?? DEFAULT_EVENTS_LIMIT;
  const offset = search.ev_offset ?? 0;

  const params: { limit: number; offset: number; kind?: string } = { limit, offset };
  if (search.ev_kind) params.kind = search.ev_kind;

  const result = useQuery(accountEventsQuery(ss58, params));
  const page = result.data?.data;
  const events = page?.events ?? [];

  // Offset pagination: a full page implies more; a short page (or a null
  // next_cursor) is the tail.
  const hasPrev = offset > 0;
  const hasNext = page?.next_cursor != null || events.length === limit;

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never,
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
    });

  // Cold accounts return a schema-stable zero — never error. While loading the
  // first page, show a skeleton instead of silently hiding the section.
  if (result.isPending && events.length === 0) {
    return (
      <AccountFeedSectionSkeleton
        id="events"
        title="Chain events"
        info="Full first-party event feed for this account, newest first — filter by kind, page through history."
      />
    );
  }

  if (result.isError) {
    return (
      <SectionAnchor
        id="events"
        title="Chain events"
        info="Full first-party event feed for this account, newest first — filter by kind, page through history."
        tone="accent"
      >
        <TableState
          variant="error"
          title="Couldn't load chain events"
          description="The chain-events feed is temporarily unavailable — the rest of the account page is unaffected."
          error={result.error}
          onRetry={() => void result.refetch()}
        />
      </SectionAnchor>
    );
  }

  return (
    <SectionAnchor
      id="events"
      title="Chain events"
      info="Full first-party event feed for this account, newest first — filter by kind, page through history."
      tone="accent"
      right={
        <div className="flex items-center gap-2">
          {kindOptions.length > 0 ? (
            <FilterChip
              ariaLabel="Filter by event kind"
              value={search.ev_kind ?? ""}
              onChange={(v) => setSearch({ ev_kind: v || undefined, ev_offset: undefined })}
              options={kindOptions.map((k) => ({ value: k.kind, label: k.kind }))}
            />
          ) : null}
          <DownloadCsvButton
            url={buildUrl(`/api/v1/accounts/${ss58}/events`, { kind: search.ev_kind })}
          />
        </div>
      }
    >
      {events.length > 0 ? (
        <DataPanel>
          <table className="w-full text-left text-sm">
            <thead className="bg-surface/50">
              <tr>
                <th className={TH}>Block</th>
                <th className={TH}>Kind</th>
                <th className={TH}>Subnet</th>
                <th className={`${TH} text-right`}>Amount</th>
                <th className={`${TH} text-right`}>Observed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {events.map((ev, i) => (
                <tr
                  key={`${ev.block_number}-${ev.event_index}-${i}`}
                  className="hover:bg-surface/30"
                >
                  <td className="px-5 py-4 font-mono text-[12px]">
                    {ev.block_number != null ? (
                      <Link
                        to="/blocks/$ref"
                        params={{ ref: String(ev.block_number) }}
                        className="text-ink hover:text-accent hover:underline"
                      >
                        #{formatNumber(ev.block_number)}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td
                    className="px-5 py-4 font-mono text-[11px] text-ink-strong"
                    title={ev.event_kind ?? undefined}
                  >
                    {eventKindLabel(ev.event_kind)}
                  </td>
                  <td className="px-5 py-4 font-mono text-[11px] text-ink-muted">
                    {ev.netuid != null ? (
                      <Link
                        to="/subnets/$netuid"
                        params={{ netuid: ev.netuid }}
                        className="hover:text-accent hover:underline"
                      >
                        SN{ev.netuid}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-5 py-4 text-right font-mono text-[11px] tabular-nums text-ink">
                    {ev.amount_tao != null ? `${formatNumber(ev.amount_tao)} τ` : "—"}
                  </td>
                  <td className="px-5 py-4 text-right font-mono text-[11px] text-ink-muted">
                    <TimeAgo at={ev.observed_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between gap-3 border-t border-border bg-surface/30 px-5 py-3 font-mono text-[11px] text-ink-muted">
            <span>
              {events.length
                ? `${formatNumber(offset + 1)}–${formatNumber(offset + events.length)}`
                : "0"}
              {search.ev_kind ? ` · ${search.ev_kind}` : ""}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSearch({ ev_offset: Math.max(0, offset - limit) || undefined })}
                disabled={!hasPrev}
                className="inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1.5 font-medium hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40 min-h-9"
              >
                <ChevronLeft className="size-3" /> Newer
              </button>
              <button
                type="button"
                onClick={() => setSearch({ ev_offset: offset + limit })}
                disabled={!hasNext}
                className="inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1.5 font-medium hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40 min-h-9"
              >
                Older <ChevronRight className="size-3" />
              </button>
            </div>
          </div>
        </DataPanel>
      ) : (
        <div className="space-y-3">
          <TableState
            variant="empty"
            title={search.ev_kind ? `No ${search.ev_kind} events` : "No chain events indexed"}
            description={
              search.ev_kind
                ? "Try clearing the kind filter or paging back to newer events."
                : "The chain poller indexes first-party events for recent blocks. Cold or inactive accounts won't appear yet."
            }
          />
          {hasPrev || search.ev_kind ? (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setSearch({ ev_offset: undefined, ev_kind: undefined })}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 font-mono text-[11px] text-ink-muted hover:border-ink/30 hover:text-ink-strong"
              >
                <ChevronLeft className="size-3" /> Back to newest
              </button>
            </div>
          ) : null}
        </div>
      )}
    </SectionAnchor>
  );
}

function DataPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={classNames(
        "overflow-x-auto rounded-[1.5rem] border border-border/80 bg-card/95 mg-card-glow",
        className,
      )}
    >
      {children}
    </div>
  );
}

function AccountHeroAside({
  registrations,
  eventKinds,
  firstSeenAt,
}: {
  registrations: number;
  eventKinds: number;
  firstSeenAt: string | null;
}) {
  return (
    <div className="w-[20rem] rounded-[1.75rem] border border-border/80 bg-card/95 p-5 mg-card-glow">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted">
            account signal
          </div>
          <div className="mt-2 font-display text-xl font-semibold text-ink-strong">
            Indexed footprint
          </div>
        </div>
        <div className="rounded-2xl bg-accent/10 p-3 text-accent">
          <Fingerprint className="size-5" />
        </div>
      </div>

      <div className="mt-5 space-y-3">
        <HeroAsideRow
          icon={Rows3}
          label="Registered subnets"
          value={formatNumber(registrations)}
          accent="live"
        />
        <HeroAsideRow
          icon={Radar}
          label="Activity kinds"
          value={formatNumber(eventKinds)}
          accent="decoded"
        />
        <HeroAsideRow
          icon={Clock}
          label="First indexed"
          value={firstSeenAt ? <TimeAgo at={firstSeenAt} /> : "—"}
          accent="near-realtime"
        />
      </div>
    </div>
  );
}

function HeroAsideRow({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof Clock;
  label: string;
  value: ReactNode;
  accent: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-surface/35 px-3.5 py-3">
      <div className="rounded-xl bg-paper p-2 text-ink-muted">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          {label}
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="truncate font-display text-lg font-semibold tabular-nums text-ink-strong">
            {value}
          </span>
          <span className="font-mono text-[10px] text-ink-muted">{accent}</span>
        </div>
      </div>
    </div>
  );
}
