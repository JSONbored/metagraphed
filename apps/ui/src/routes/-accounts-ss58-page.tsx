import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import {
  AlertCircle,
  ChevronLeft,
  Github,
  Globe,
  MessageCircle,
  RefreshCw,
  Tag,
} from "lucide-react";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { PriceAtTx } from "@/components/metagraphed/price-at-tx";
import { AddressLabelEditor } from "@/components/metagraphed/address-label-editor";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { AccountRootClaim } from "@/components/metagraphed/account-root-claim";
import {
  EmptyState,
  ErrorState,
  Skeleton,
  StatUnavailable,
  StaleBanner,
} from "@/components/metagraphed/states";
import { statPhase, type StatPhase } from "@/lib/metagraphed/stat-phase";
import { SelectFilter, FilterChip } from "@/components/metagraphed/table-controls";
import { EndpointSnippet } from "@/components/metagraphed/endpoint-snippet";
import { WatchStarButton } from "@/components/metagraphed/watch-star-button";
import {
  CopyableCode,
  TimeAgo,
  Chip,
  ExternalLink,
  BackToTop,
  Definition,
  AnalyticsSection,
  FactStrip,
  FactCell,
  EntityHero,
  FactSentence,
  SectionNav,
  RankedRails,
  DataTable,
  type CellValue,
} from "@jsonbored/ui-kit";
import { AsyncPanel } from "@/components/metagraphed/primitives";
import { RouterLink } from "@/components/metagraphed/router-link";
import { AccountHistoryChart } from "@/components/metagraphed/account-history-chart";
import { AccountPositionHistoryChart } from "@/components/metagraphed/account-position-history-chart";
import { AccountHoldingsHistory } from "@/components/metagraphed/account-holdings-history";
import {
  accountAxonRemovalsQuery,
  accountChildrenQuery,
  accountCounterpartiesQuery,
  accountEntitiesQuery,
  accountParentsQuery,
  accountStakeFlowQuery,
  accountPortfolioQuery,
  accountStakeMovesQuery,
  accountDeregistrationsQuery,
  accountRegistrationsQuery,
  accountWeightSettersQuery,
  accountBalanceQuery,
  accountIdentityHistoryQuery,
  accountIdentityQuery,
  accountEventsQuery,
  accountExtrinsicsQuery,
  accountPrometheusQuery,
  accountQuery,
  accountServingQuery,
  accountSubnetsQuery,
  accountTransfersQuery,
  nametagIndexQuery,
  validatorDetailQuery,
  validatorHistoryQuery,
} from "@/lib/metagraphed/queries";
import {
  apyFromRewardsPer1000,
  formatApyPct,
  formatTakePct,
} from "@/lib/metagraphed/validator-apy";
import { classNames, formatNumber, formatTao, isStaleFreshness } from "@/lib/metagraphed/format";
import { resolveAddress } from "@/lib/metagraphed/resolve-address";
import { useAddressLabels } from "@/lib/metagraphed/address-labels";
import { extrinsicCall } from "@/lib/metagraphed/extrinsics";
import { summarizeCall } from "@/lib/metagraphed/chain-summaries";
import { ss58PathSegment } from "@/lib/metagraphed/accounts";
import { accountFeedSectionPhase } from "@/lib/metagraphed/account-feed-section";
import { eventKindLabel } from "@/lib/metagraphed/event-kinds";
import { subnetPositionSearch } from "@/lib/metagraphed/subnet-position-link";
import {
  accountRole,
  isDualRoleAccount,
  isImplausibleTao,
  IMPLAUSIBLE_TAO_NOTE,
  type AccountRole,
} from "@/lib/metagraphed/account-role";
import type {
  AccountCounterparty,
  AccountDelegationGraph,
  AccountDelegationSubnet,
  AccountEntityLabel,
  AccountEvent,
  AccountOwnershipTie,
  AccountStakeFlowSubnet,
  AccountRegistration,
  AccountSummary,
  Extrinsic,
  Transfer,
} from "@/lib/metagraphed/types";
import { DEFAULT_EVENTS_LIMIT } from "./accounts.$ss58";
import { QUERY_PARAMETER_ENUMS } from "@jsonbored/metagraphed";
import { railItems } from "@/lib/metagraphed/rails";

// #8358: detail-page template tabs. Overview carries the KPI band's context
// plus a bounded recent-activity preview; everything else is a full,
// unbounded view one tap away. Mirrors -subnets-netuid-page.tsx's TABS/
// every section renders on one page, so hash deep links just work.
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "positions", label: "Positions" },
  // #8370: holdings over time — the story of the address, not just its
  // snapshot. Named "holdings" internally because the "history" SECTION id
  // below is already taken by the Activity tab's daily-activity anchor.
  { id: "holdings", label: "History" },
  { id: "transfers", label: "Transfers" },
  { id: "activity", label: "Activity" },
  { id: "extrinsics", label: "Extrinsics" },
  { id: "api", label: "API" },
] as const;

export function AccountDetailPage() {
  const { ss58 } = useParams({ from: "/accounts/$ss58" });
  return (
    <AppShell>
      <AsyncPanel
        context="account"
        fallback={<DetailSkeleton />}
        retryQueryKeys={[accountQuery(ss58).queryKey]}
      >
        <AccountDetail ss58={ss58} />
      </AsyncPanel>
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
  const identityResult = useQuery(accountIdentityQuery(ss58));
  const identity = identityResult.data?.data;
  // #8372: the masthead title is the single most prominent "detail context"
  // on the site (requirement 3's own example of where a category chip
  // belongs) -- resolve through the same private-label -> identity ->
  // nametag -> truncated ladder AddressDisplay uses elsewhere on this page,
  // rather than leaving this one title as the last hand-rolled identity-only
  // ternary. A plain resolveAddress() call, not <AddressDisplay>: this is a
  // page title, not a table cell -- no copy button or self-link belongs in
  // an H1 for the page the reader is already on.
  const { data: nametags } = useQuery(nametagIndexQuery());
  // #8484: the masthead title is also the primary detail-context entry point
  // for the private-label editor (below, next to the ss58/role chip row).
  const { getLabel } = useAddressLabels();
  const resolvedTitle = resolveAddress(ss58, {
    localLabel: getLabel(ss58)?.name,
    identityName: identity?.has_identity ? identity.name : undefined,
    nametag: nametags?.get(ss58) ?? null,
    keep: 8,
  });
  // #8358 KPI band: the same portfolio/stake-flow/validator/prometheus queries
  // the Positions and Activity tab sections already fetch below, called once
  // more here (React Query dedupes by key -- this is a shared cache read, not
  // a second network round-trip) so the always-visible band above the tabs
  // can show live numbers without waiting for whichever tab first mounts them.
  const portfolioResult = useQuery(accountPortfolioQuery(ss58));
  const portfolio = portfolioResult.data?.data;
  const stakeFlowResult = useQuery(accountStakeFlowQuery(ss58, { window: "30d" }));
  const stakeFlow = stakeFlowResult.data?.data;
  const validatorResult = useQuery(validatorDetailQuery(ss58));
  const validator = validatorResult.data?.data;
  // #2551 methodology, same as ValidatorApyPanel/validator-columns.tsx's "Est.
  // APY" column: annualized from the daily neuron_daily rewards-per-1000-TAO
  // rollup, net of take. validatorDetailQuery's own /validators/{hotkey}
  // response has no rate field to read directly (only the list endpoint's
  // apy_estimate does) -- history is the correct source, not a substitute.
  const validatorHistoryResult = useQuery(validatorHistoryQuery(ss58, "30d"));
  const latestRewardsPer1000 = validatorHistoryResult.data?.data?.points.find(
    (p) => p.rewards_per_1000_tao != null && Number.isFinite(p.rewards_per_1000_tao),
  )?.rewards_per_1000_tao;
  const estApyPct = apyFromRewardsPer1000(latestRewardsPer1000, validator?.take);
  const prometheusResult = useQuery(accountPrometheusQuery(ss58));
  const prometheus = prometheusResult.data?.data;
  // Prometheus/serving announcements are per-subnet; the KPI band's "Serving"
  // tile wants one liveness signal, so this takes the most recent
  // announcement across every subnet this hotkey has announced on.
  const lastAnnouncedAt =
    prometheus?.subnets.reduce<string | null>((latest, s) => {
      if (!s.last_announced_at) return latest;
      return !latest || s.last_announced_at > latest ? s.last_announced_at : latest;
    }, null) ?? null;
  // Signed extrinsics + native-TAO transfers are separate sub-resources (#264),
  // fetched non-blocking so a cold/slow tier never stalls the summary above.
  const extrinsicsResult = useQuery(accountExtrinsicsQuery(ss58, { limit: 25 }));
  const transfersResult = useQuery(accountTransfersQuery(ss58, { limit: 25 }));
  const signedExtrinsics = extrinsicsResult.data?.data ?? [];
  const transfers = transfersResult.data?.data ?? [];

  // #8252: guard against an absurd balance rendering as fact. TAO's total
  // issuance is capped at 21M, so anything above it is definitionally a
  // decode/unit bug upstream (exactly the class the Phase-0 u64-vs-u128 fix
  // in #8259 corrected, which had rendered "2,324,289,753,287.40M τ" on a
  // whale coldkey). Show "—" with an explanatory tooltip rather than a number
  // no reader can distinguish from a real holding.
  const balanceImplausible = isImplausibleTao(balance?.balance_tao);

  const hasActivity =
    account.event_count > 0 || account.registrations.length > 0 || account.recent_events.length > 0;

  // #8252: which face leads by default. A coldkey's story is balance /
  // positions / transfers; a hotkey's is registrations / validator context /
  // serving. #8358 adds a third case: the same address can genuinely be both
  // (registered on-chain AND independently holding wallet balance) -- that
  // gets the coldkey KPI set by default, with an explicit toggle to the
  // hotkey set, rather than guessing which the visitor wants.
  const detectedRole = accountRole(account);
  const dualRole = isDualRoleAccount(account, balance?.balance_tao);
  const [roleView, setRoleView] = useState<AccountRole>(detectedRole);

  return (
    <>
      <EntityHero
        name={resolvedTitle.display}
        action={
          <>
            <div className="mg-actions">
              <WatchStarButton kind="account" id={ss58} label="this account" iconOnly />
            </div>
            {/* #8484: outside the ActionBar (its children need their own
                `bare` variant for the segmented look) but still in `actions`
                -- unlike `description`, this row isn't `line-clamp`-collapsed,
                so the entry point stays reachable regardless of how long the
                description text runs. */}
            <AddressLabelEditor ss58={ss58} />
            {isStaleFreshness(generatedAt) ? (
              <StaleBanner
                compact
                generatedAt={generatedAt}
                refreshQueryKeys={[accountQuery(ss58).queryKey]}
              />
            ) : null}
          </>
        }
        sentence={
          <FactSentence>
            {
              <div className="space-y-4">
                <p className="max-w-2xl">
                  {identity?.has_identity && identity.description
                    ? identity.description
                    : "Cross-subnet registrations, first-party chain events, and daily activity rollups for one Bittensor account."}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="max-w-full sm:max-w-fit rounded border border-border/80 bg-card px-3 py-2">
                    <CopyableCode value={ss58} truncate={false} className="max-w-full" />
                  </div>
                  <RoleChip role={detectedRole} dual={dualRole} />
                  {resolvedTitle.source === "nametag" && resolvedTitle.category ? (
                    <Chip tone="muted" title={`Curated nametag · ${resolvedTitle.category}`}>
                      {resolvedTitle.category}
                    </Chip>
                  ) : null}
                </div>
              </div>
            }
          </FactSentence>
        }
      />

      <AccountKpiBand
        role={dualRole ? roleView : detectedRole}
        dual={dualRole}
        onRoleChange={setRoleView}
        account={account}
        balance={balance}
        balanceError={balanceResult.isError}
        balanceImplausible={balanceImplausible}
        onRetryBalance={() => void balanceResult.refetch()}
        portfolio={portfolio}
        portfolioPhase={statPhase(portfolioResult)}
        stakeFlow={stakeFlow}
        validator={validator}
        estApyPct={estApyPct}
        lastAnnouncedAt={lastAnnouncedAt}
      />

      <SectionNav items={TABS.map((t) => ({ id: t.id, name: t.label }))} />

      {!hasActivity ? (
        <EmptyState
          title="No activity indexed for this account"
          description="The chain poller indexes first-party events for recent blocks. Cold accounts or those without recent on-chain activity won't appear yet."
          action={{ label: "Back to accounts", href: "/accounts" }}
        />
      ) : null}

      <div id="overview" data-tab="overview">
        <>
          {identity?.has_identity ? <AccountIdentitySection ss58={ss58} /> : null}
          <AccountRecentActivityPreview events={account.recent_events} />
          <AccountEntitiesSection ss58={ss58} />
        </>
      </div>

      <div id="positions" data-tab="positions">
        <>
          {/* #8252: coldkey leads with what it holds; hotkey leads with its
              registrations. Both render the same section set within this tab. */}
          {detectedRole === "coldkey" ? (
            <>
              <AccountPortfolioSection ss58={ss58} />
              <AccountStakeFlowSection ss58={ss58} />
              <AccountStakeMovesSection ss58={ss58} />
              <AccountFootprintSection ss58={ss58} fallback={account.registrations} />
            </>
          ) : (
            <>
              <AccountFootprintSection ss58={ss58} fallback={account.registrations} />
              <AccountStakeFlowSection ss58={ss58} />
              <AccountPortfolioSection ss58={ss58} />
              <AccountStakeMovesSection ss58={ss58} />
            </>
          )}
          {/* #6723: live child/parent-hotkey stake-weight delegation graph. */}
          <AccountDelegationSection ss58={ss58} />
        </>
      </div>

      <div id="holdings" data-tab="holdings">
        <AnalyticsSection
          id="holdings-history"
          name="Holdings over time"
          question="Staked τ by subnet from daily position snapshots — free balance stays a live read in the band above."
          footnote="Depth is limited by how far back daily snapshots reach; it grows as the genesis backfill (#8368) lands."
        >
          <AccountHoldingsHistory ss58={ss58} />
        </AnalyticsSection>
      </div>

      <div data-tab="holdings">
        <AnalyticsSection
          id="root-claim"
          name="Root claim"
          question="What this account's root stake would do in a swap, and which hotkeys it reaches."
          footnote="GET /api/v1/accounts/{ss58}/root-claim — the payload's own `field_sources` marks the claim type as MEASURED (read from SubtensorModule.RootClaimType) and the hotkey list as RECONSTRUCTED (inferred from other state). The panel shows that provenance beside the figure it qualifies rather than rendering an inference with the authority of a reading."
        >
          <AccountRootClaim ss58={ss58} />
        </AnalyticsSection>
      </div>

      <div id="transfers" data-tab="transfers">
        <>
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
        </>
      </div>

      <div id="activity" data-tab="activity">
        <>
          {/* Daily activity is a hotkey-keyed rollup -- rendering it for a
              coldkey guarantees the framed "No daily hotkey activity yet"
              panel the redesign removes, so it's hotkey-only by construction
              rather than relying on an empty state to explain itself. */}
          {detectedRole === "hotkey" ? (
            <AnalyticsSection
              id="history"
              name="Daily activity"
              question="Per-day first-party account events, newest rollups from the chain-direct explorer."
              footnote="History is keyed by hotkey activity only."
              controls={<SectionBadge tone="accent">hotkey rollup</SectionBadge>}
            >
              <AccountHistoryChart ss58={ss58} />
            </AnalyticsSection>
          ) : null}
          <AccountTeardownActivitySection ss58={ss58} />
          <AccountRegistrationActivitySection ss58={ss58} />
          <AccountDeregistrationActivitySection ss58={ss58} />
          <AccountWeightSettingSection ss58={ss58} />
          <AccountEndpointAnnouncementSection ss58={ss58} />
          {account.event_kinds.length > 0 ? (
            <AnalyticsSection
              id="kinds"
              name="Activity by kind"
              question="Relative event mix across the indexed sample for this account."
              controls={
                <SectionBadge>{formatNumber(account.event_kinds.length)} kinds</SectionBadge>
              }
            >
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {account.event_kinds.map((entry) => (
                  <div key={entry.kind} className="rounded border border-border/80 px-4 py-3">
                    <div className="text-13 text-ink-muted">event kind</div>
                    <div className="mt-2 flex items-end justify-between gap-3">
                      <span className="min-w-0 truncate font-mono text-13 text-ink-strong">
                        {entry.kind}
                      </span>
                      <span className="font-display text-28 font-semibold tabular-nums text-ink-strong">
                        {formatNumber(entry.count)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </AnalyticsSection>
          ) : null}
          <AccountEventsSection ss58={ss58} kindOptions={account.event_kinds} />
        </>
      </div>

      <div id="extrinsics" data-tab="extrinsics">
        <AccountExtrinsicsSection
          ss58={ss58}
          rows={signedExtrinsics}
          isPending={extrinsicsResult.isPending}
          isError={extrinsicsResult.isError}
          error={extrinsicsResult.error}
          onRetry={() => void extrinsicsResult.refetch()}
        />
      </div>

      <div id="api" data-tab="api">
        <AnalyticsSection
          id="call"
          name="Call this endpoint"
          question="Copy a ready-to-run request for this account."
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
              { label: "children", path: `/api/v1/accounts/${sourceRef}/children` },
              { label: "parents", path: `/api/v1/accounts/${sourceRef}/parents` },
              { label: "entities", path: `/api/v1/accounts/${sourceRef}/entities` },
              { label: "stake-flow", path: `/api/v1/accounts/${sourceRef}/stake-flow` },
              { label: "serving", path: `/api/v1/accounts/${sourceRef}/serving` },
              { label: "prometheus", path: `/api/v1/accounts/${sourceRef}/prometheus` },
            ]}
          />
        </AnalyticsSection>
      </div>

      {/* #6432: deliberately NOT "← All accounts" like the other detail pages'
          back-links. /accounts is a lookup form, not an index -- there is no
          list of every chain account to go back to -- so the label names what
          the destination actually is. Sibling pages (blocks, extrinsics,
          validators, subnets) do point at real directories and use "← All X". */}
      <div className="mt-6">
        <Link
          to="/accounts"
          className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-11 font-medium hover:border-ink/30"
        >
          ← Account lookup
        </Link>
      </div>

      <ApiSourceFooter
        paths={[
          `/api/v1/accounts/${sourceRef}`,
          `/api/v1/accounts/${sourceRef}/identity`,
          `/api/v1/accounts/${sourceRef}/history`,
          `/api/v1/accounts/${sourceRef}/events`,
          `/api/v1/accounts/${sourceRef}/subnets`,
          `/api/v1/accounts/${sourceRef}/counterparties`,
          `/api/v1/accounts/${sourceRef}/children`,
          `/api/v1/accounts/${sourceRef}/parents`,
          `/api/v1/accounts/${sourceRef}/entities`,
          `/api/v1/accounts/${sourceRef}/stake-flow`,
          `/api/v1/accounts/${sourceRef}/serving`,
          `/api/v1/accounts/${sourceRef}/prometheus`,
        ]}
      />
      <BackToTop />
    </>
  );
}

/** Detected on-chain role, always visible in the header regardless of which
 * KPI set is currently shown (#8358). */
function RoleChip({ role, dual }: { role: AccountRole; dual: boolean }) {
  const label = dual ? "coldkey + hotkey" : role;
  return (
    <span className="inline-flex items-center rounded border border-border bg-card px-3 py-1.5 text-13 text-ink-muted">
      {label}
    </span>
  );
}

/**
 * Role-adaptive KPI band (#8358) -- what leads depends on what this address
 * actually does, same inference `accountRole` already uses. A coldkey's
 * facts are about what it holds and moves; a hotkey's are about what it's
 * staked to validate/mine. A dual-role address gets the coldkey set by
 * default (identical to a pure coldkey) plus an explicit toggle, rather than
 * silently picking one -- the visitor decides which story they want.
 *
 * "Est. APY" reuses the exact #2551 methodology the validators list/detail
 * pages already compute (`apyFromRewardsPer1000`) rather than deriving a new,
 * possibly-wrong rate from emission/stake -- `validatorDetailQuery`'s own
 * response has no rate field, so the caller also fetches a 30d
 * `validatorHistoryQuery` just for this tile (see ValidAccountDetail).
 */
function AccountKpiBand({
  role,
  dual,
  onRoleChange,
  account,
  balance,
  balanceError,
  balanceImplausible,
  onRetryBalance,
  portfolio,
  portfolioPhase,
  stakeFlow,
  validator,
  estApyPct,
  lastAnnouncedAt,
}: {
  role: AccountRole;
  dual: boolean;
  onRoleChange: (role: AccountRole) => void;
  account: AccountSummary;
  balance?: { balance_tao: number | null } | null;
  balanceError: boolean;
  balanceImplausible: boolean;
  onRetryBalance: () => void;
  portfolio?: {
    position_count: number;
    subnet_count: number;
    total_stake_tao: number | null;
  } | null;
  portfolioPhase: StatPhase;
  stakeFlow?: { net_flow_tao: number | null; window: string } | null;
  validator?: {
    total_stake_tao: number;
    nominator_count: number | null;
    take: number | null;
  } | null;
  estApyPct: number | null;
  lastAnnouncedAt: string | null;
}) {
  const freeValue = balanceError ? (
    <span className="inline-flex items-center gap-2">
      <AlertCircle aria-hidden className="size-4 text-health-down" />
      <span className="text-16 font-medium text-health-down">Unavailable</span>
      <button
        type="button"
        onClick={onRetryBalance}
        className="inline-flex items-center gap-1 rounded border border-border bg-paper px-2 py-0.5 text-11 font-medium text-ink hover:border-accent/50 hover:text-accent transition-colors"
      >
        <RefreshCw className="size-3" /> Retry
      </button>
    </span>
  ) : balanceImplausible ? (
    <Definition term="Balance" sentence={IMPLAUSIBLE_TAO_NOTE}>
      <span className="inline-flex items-center gap-1.5">
        <span>—</span>
        <AlertCircle aria-hidden className="size-3.5 text-health-warn" />
      </span>
    </Definition>
  ) : balance?.balance_tao != null ? (
    formatTao(balance.balance_tao)
  ) : (
    "—"
  );

  const staked = portfolio?.total_stake_tao ?? null;
  const free = balanceImplausible || balanceError ? null : (balance?.balance_tao ?? null);
  const total = free != null && staked != null ? free + staked : null;

  const netFlow = stakeFlow?.net_flow_tao ?? null;
  const netFlowStr =
    netFlow == null ? "—" : `${netFlow >= 0 ? "+" : "−"}${fmtTaoCompact(Math.abs(netFlow))}`;

  return (
    <div className="mb-8">
      {dual ? (
        <div className="mb-3 flex items-center gap-2">
          <span className="text-13 text-ink-muted">Showing:</span>
          {(["coldkey", "hotkey"] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onRoleChange(r)}
              aria-pressed={role === r}
              className={classNames(
                "rounded border px-3 py-1 text-11 transition-colors",
                role === r
                  ? "border-accent/40 bg-accent/10 text-accent-text"
                  : "border-border bg-card text-ink-muted hover:border-ink/30",
              )}
            >
              {r}
            </button>
          ))}
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {role === "coldkey" ? (
          <>
            <FactCell
              label="Total balance"
              value={total != null ? fmtTaoCompact(total) : freeValue}
              hint="free + staked · live RPC"
              className="rounded p-4"
            />
            <FactCell
              label="Free / staked"
              value={
                <span className="text-11">
                  {freeValue} <span className="text-ink-muted">/</span>{" "}
                  {staked != null ? fmtTaoCompact(staked) : "—"}
                </span>
              }
              hint="wallet · positions"
              className={KPI_TILE}
            />
            <FactCell
              label="Positions"
              value={(() => {
                if (portfolioPhase === "pending") return <Skeleton className="h-5 w-10" />;
                if (portfolioPhase === "error") return <StatUnavailable />;
                return formatNumber(portfolio?.position_count);
              })()}
              hint={(() => {
                if (portfolioPhase !== "ready") return null;
                return portfolio
                  ? `across ${formatNumber(portfolio.subnet_count)} subnets`
                  : "no positions";
              })()}
              className={KPI_TILE}
            />
            <FactCell
              label="First seen"
              value={<TimeAgo at={account.first_seen_at ?? undefined} />}
              hint="chain-direct index"
              className={KPI_TILE}
            />
            <FactCell
              label="Last active"
              value={<TimeAgo at={account.last_seen_at ?? undefined} />}
              hint="near-realtime"
              className={KPI_TILE}
            />
            <FactCell
              label="Net stake flow"
              value={
                <span
                  className={
                    netFlow != null && netFlow < 0 ? "text-health-warn-text" : "text-health-ok"
                  }
                >
                  {netFlowStr}
                </span>
              }
              hint={`over ${stakeFlow?.window ?? "30d"}`}
              className={KPI_TILE}
            />
          </>
        ) : (
          <>
            <FactCell
              label="Stake"
              value={fmtTaoCompact(validator?.total_stake_tao)}
              hint="validator detail · cross-subnet"
              className="rounded p-4"
            />
            <FactCell
              label="Nominators"
              value={
                validator?.nominator_count != null ? formatNumber(validator.nominator_count) : "—"
              }
              hint="delegating coldkeys"
              className={KPI_TILE}
            />
            <FactCell
              label="Take"
              value={formatTakePct(validator?.take)}
              hint="validator cut"
              className={KPI_TILE}
            />
            <FactCell
              label="Est. APY"
              value={formatApyPct(estApyPct)}
              hint="net of take · 30d rewards"
              className={KPI_TILE}
            />
            <FactCell
              label="Serving"
              value={lastAnnouncedAt ? <TimeAgo at={lastAnnouncedAt} /> : "—"}
              hint="last endpoint announcement"
              className={KPI_TILE}
            />
            <FactCell
              label="Last active"
              value={<TimeAgo at={account.last_seen_at ?? undefined} />}
              hint="near-realtime"
              className={KPI_TILE}
            />
          </>
        )}
      </div>
    </div>
  );
}

/** Overview tab's bounded activity preview (#8358) -- reuses the same first
 * page the summary payload already carries (`account.recent_events`, no extra
 * query), capped to 10 rows, deep-linking into the full Activity tab feed. */
function AccountRecentActivityPreview({ events }: { events: AccountEvent[] }) {
  const rows = events.slice(0, 10);
  if (rows.length === 0) return null;
  return (
    <AnalyticsSection
      id="recent-activity"
      name="Recent activity"
      question="The newest first-party events for this account."
      controls={
        <Link
          to="."
          search={(prev: Record<string, unknown>) => ({ ...prev, tab: "activity" })}
          className="text-11 text-ink-muted transition-colors hover:text-accent hover:underline"
        >
          View all →
        </Link>
      }
    >
      <div className="space-y-2">
        {rows.map((ev, i) => (
          <div
            key={`${ev.block_number}-${ev.event_index}-${i}`}
            className="flex items-center justify-between gap-3 rounded border border-border/80 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-11 text-ink-strong">
                {eventKindLabel(ev.event_kind)}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-10 text-ink-muted">
                {ev.block_number != null ? (
                  <Link
                    to="/blocks/$ref"
                    params={{ ref: String(ev.block_number) }}
                    className="hover:text-accent hover:underline"
                  >
                    #{formatNumber(ev.block_number)}
                  </Link>
                ) : null}
                {ev.netuid != null ? (
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: ev.netuid }}
                    className="hover:text-accent hover:underline"
                  >
                    SN{ev.netuid}
                  </Link>
                ) : null}
              </div>
            </div>
            <div className="shrink-0 text-right">
              {ev.amount_tao != null ? (
                <div className="text-11 tabular-nums text-ink">{formatNumber(ev.amount_tao)} τ</div>
              ) : null}
              <div className="text-10 text-ink-muted">
                <TimeAgo at={ev.observed_at} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </AnalyticsSection>
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
        "inline-flex items-center rounded border px-3 py-1 text-10",
        tone === "accent"
          ? "border-accent/30 bg-accent/10 text-accent"
          : "border-border bg-card text-ink-muted",
      )}
    >
      {children}
    </span>
  );
}

/** `DataTable` cell formatter for a count column, in this page's units. */
function fmtCount(value: CellValue): string {
  return formatNumber(typeof value === "number" ? value : null);
}

/** `DataTable` cell formatter for a τ amount, matching `fmtStake`. */
function fmtStakeCell(value: CellValue): string {
  return fmtStake(typeof value === "number" ? value : null);
}

/** `#12,345`, the block-number form every feed on this page uses. */
function fmtBlock(value: CellValue): string {
  return typeof value === "number" ? `#${formatNumber(value)}` : "—";
}

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
    <AnalyticsSection id={id} name={title} question={subtitle} footnote={info}>
      <Skeleton className="h-64 w-full" />
    </AnalyticsSection>
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
      <AnalyticsSection
        id="extrinsics"
        name="Signed extrinsics"
        footnote="The newest transactions this account signed, from the chain-direct extrinsics tier."
      >
        <ErrorState error={error} onRetry={onRetry} context="signed extrinsics" />
      </AnalyticsSection>
    );
  }
  if (phase === "empty") return null;
  return (
    <AnalyticsSection
      id="extrinsics"
      name="Signed extrinsics"
      footnote="The newest transactions this account signed, from the chain-direct extrinsics tier."
      controls={<SectionBadge>{formatNumber(rows.length)} rows</SectionBadge>}
    >
      <DataTable
        rows={rows}
        rowKey={(row) => row.extrinsic_hash ?? `${row.block_number}-${row.extrinsic_index}`}
        caption="Signed extrinsics"
        captionHidden
        link={RouterLink}
        source="account-extrinsics"
        columns={[
          {
            key: "block",
            label: "Block",
            sortable: true,
            value: (row) => row.block_number,
            format: fmtBlock,
            render: (row) =>
              row.block_number != null ? (
                <Link
                  to="/blocks/$ref"
                  params={{ ref: String(row.block_number) }}
                  className="text-ink hover:text-accent hover:underline"
                >
                  #{formatNumber(row.block_number)}
                  {row.extrinsic_index != null ? (
                    <span className="text-ink-muted">·{row.extrinsic_index}</span>
                  ) : null}
                </Link>
              ) : (
                "—"
              ),
          },
          {
            key: "call",
            label: "Call",
            // #8371: this section is scoped to extrinsics `ss58` itself
            // signed, so it's always the right signer context for the
            // sentence -- unlike a generic feed, no per-row signer field
            // to read.
            value: (row) =>
              summarizeCall(row.call_module, row.call_function, row.call_args, { signer: ss58 }) ??
              extrinsicCall(row.call_module, row.call_function),
            render: (row) => {
              const sentence =
                summarizeCall(row.call_module, row.call_function, row.call_args, {
                  signer: ss58,
                }) ?? extrinsicCall(row.call_module, row.call_function);
              return row.extrinsic_hash ? (
                <Link
                  to="/extrinsics/$hash"
                  params={{ hash: row.extrinsic_hash }}
                  className="hover:text-accent hover:underline"
                >
                  {sentence}
                </Link>
              ) : (
                sentence
              );
            },
          },
          {
            key: "result",
            label: "Result",
            kind: "status",
            value: (row) => (row.success == null ? null : row.success ? "ok" : "failed"),
          },
          {
            key: "observed",
            label: "Observed",
            kind: "time",
            align: "right",
            sortable: true,
            value: (row) => row.observed_at,
          },
        ]}
      />
    </AnalyticsSection>
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
      <AnalyticsSection
        id="transfers"
        name="Transfers"
        footnote="Native-TAO Balances.Transfer activity for this account, directional (sent / received)."
      >
        <ErrorState error={error} onRetry={onRetry} context="transfers" />
      </AnalyticsSection>
    );
  }
  if (phase === "empty") return null;
  return (
    <AnalyticsSection
      id="transfers"
      name="Transfers"
      footnote="Native-TAO Balances.Transfer activity for this account, directional (sent / received)."
      controls={<SectionBadge>{formatNumber(rows.length)} rows</SectionBadge>}
    >
      <DataTable
        rows={rows}
        rowKey={(row) => `${row.block_number}-${row.event_index}`}
        caption="Transfers"
        captionHidden
        link={RouterLink}
        source="account-transfers"
        columns={[
          {
            key: "block",
            label: "Block",
            sortable: true,
            value: (row) => row.block_number,
            format: fmtBlock,
            render: (row) =>
              row.block_number != null ? (
                <Link
                  to="/blocks/$ref"
                  params={{ ref: String(row.block_number) }}
                  className="text-ink hover:text-accent hover:underline"
                >
                  #{formatNumber(row.block_number)}
                </Link>
              ) : (
                "—"
              ),
          },
          {
            key: "direction",
            label: "Direction",
            value: (row) => row.direction,
            // Sent and received are the two halves of one flow, not health
            // states, so they keep this page's own directional tones rather
            // than the status dot's ok/warn/down vocabulary.
            render: (row) =>
              row.direction === "received" ? (
                <span className="text-health-ok">received</span>
              ) : row.direction === "sent" ? (
                <span className="text-health-warn-text">sent</span>
              ) : (
                <span className="text-ink-muted">—</span>
              ),
          },
          {
            key: "counterparty",
            label: "Counterparty",
            value: (row) => transferCounterparty(row),
            render: (row) => {
              const counterparty = transferCounterparty(row);
              return (
                <AddressDisplay
                  ss58={counterparty}
                  fallback={<>{counterparty ?? "—"}</>}
                  linkToAccount={counterparty !== ss58}
                />
              );
            },
          },
          {
            key: "amount",
            label: "Amount",
            kind: "number",
            sortable: true,
            value: (row) => row.amount_tao,
            format: fmtStakeCell,
          },
          {
            key: "observed",
            label: "Observed",
            kind: "time",
            align: "right",
            sortable: true,
            value: (row) => row.observed_at,
          },
        ]}
      />
    </AnalyticsSection>
  );
}

/** The other side of a transfer: whoever this account was not. */
function transferCounterparty(t: Transfer): string | null {
  return t.direction === "sent" ? t.to : t.from;
}

function fmtStake(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${formatNumber(v)} τ`;
}

/** α for alpha, this app's established glyph (stake-amount-input.tsx).
 *
 * Root (netuid 0) stake really is TAO; every other subnet's is that subnet's
 * own alpha token (metagraphed#10514). Rendering an alpha figure with a τ was
 * the same unit claim the field name used to make. */
function fmtPositionStake(v: number | null | undefined, netuid: number): string {
  if (v == null) return "—";
  return `${formatNumber(v)} ${netuid === 0 ? "τ" : "α"}`;
}

// Alpha price-at-tx (#4332/6.3, #4333/6.4) -- same precision rule as
// subnet-price-ticker.tsx's priceStr, since this is the same alpha_price_tao
// unit shown there.
function fmtAlphaPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v < 0.001) return `${v.toExponential(2)} τ`;
  return `${v < 1 ? v.toFixed(4) : v.toFixed(3)} τ`;
}

const KPI_TILE = "rounded border-border/80 p-4";

// Compact TAO formatter for the portfolio KPI tiles — a long raw value like
// "338,030.153 τ" wraps + overflows a narrow FactCell, so summarise it (338.0k τ).
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
      <AnalyticsSection
        id="stake-moves"
        name="Stake moves"
        question="Where this account re-delegated stake over the window: total movements, the subnets it moved across, and the per-subnet breakdown."
      >
        <ErrorState
          error={result.error}
          onRetry={() => void result.refetch()}
          context="stake moves"
        />
      </AnalyticsSection>
    );
  }
  const subnets = m?.subnets ?? [];
  if (!m || subnets.length === 0) return null;
  const rows = [...subnets].sort((a, b) => b.movements - a.movements);

  return (
    <AnalyticsSection
      id="stake-moves"
      name="Stake moves"
      question="Where this account re-delegated stake over the window: total movements, the subnets it moved across, and the per-subnet breakdown."
      footnote="Re-delegation activity for this account, from /api/v1/accounts/{ss58}/stake-moves — total movements over the window, how concentrated they are, the dominant subnet, and the per-subnet breakdown."
      controls={<SectionBadge tone="accent">{formatNumber(m.subnet_count)} subnets</SectionBadge>}
    >
      <FactStrip variant="grid">
        <FactCell
          label="Movements"
          value={formatNumber(m.total_movements)}
          hint={`over ${m.window}`}
          className={KPI_TILE}
        />
        <FactCell
          label="Subnets moved"
          value={formatNumber(m.subnet_count)}
          hint="distinct subnets"
          className={KPI_TILE}
        />
        <FactCell
          label="Concentration"
          value={m.concentration != null ? m.concentration.toFixed(4) : "—"}
          hint="0 = spread, 1 = single"
          className={KPI_TILE}
        />
        <FactCell
          label="Dominant subnet"
          value={m.dominant_netuid != null ? `SN${m.dominant_netuid}` : "—"}
          hint="most-moved"
          className={KPI_TILE}
        />
      </FactStrip>
      <DataTable
        rows={rows}
        rowKey={(row) => String(row.netuid)}
        caption="Stake moves by subnet"
        captionHidden
        link={RouterLink}
        source="account-stake-moves"
        pageSize={20}
        rowHref={(row) => `/subnets/${row.netuid}`}
        columns={[
          {
            key: "netuid",
            label: "Subnet",
            sortable: true,
            value: (row) => row.netuid,
            format: (value) => `SN${String(value)}`,
          },
          {
            key: "movements",
            label: "Movements",
            kind: "number",
            sortable: true,
            value: (row) => row.movements,
            format: fmtCount,
          },
          {
            key: "last_moved",
            label: "Last moved",
            kind: "time",
            align: "right",
            sortable: true,
            value: (row) => row.last_moved_at,
          },
          {
            key: "price",
            label: "Price at last move",
            kind: "number",
            sortable: true,
            value: (row) => row.price_tao_at_last_move,
            format: (_value, row) => fmtAlphaPrice(row.price_tao_at_last_move),
          },
        ]}
      />
    </AnalyticsSection>
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
      <AnalyticsSection id="counterparties" name="Counterparties" question={SUBTITLE}>
        <ErrorState
          error={result.error}
          onRetry={() => void result.refetch()}
          context="counterparties"
        />
      </AnalyticsSection>
    );
  }
  const parties = c?.counterparties ?? [];
  if (!c || parties.length === 0) return null;
  const volume = (p: AccountCounterparty) => (p.sent_tao ?? 0) + (p.received_tao ?? 0);
  const rows = [...parties].sort((a, b) => volume(b) - volume(a));

  return (
    <AnalyticsSection
      id="counterparties"
      name="Counterparties"
      question={SUBTITLE}
      footnote="Fund-flow leaderboard from /api/v1/accounts/{ss58}/counterparties — the top addresses by transfer volume, with sent/received/net totals and the last block each was active in."
      controls={
        <SectionBadge tone="accent">{formatNumber(c.counterparty_count)} addresses</SectionBadge>
      }
    >
      <FactStrip variant="grid">
        <FactCell
          label="Counterparties"
          value={formatNumber(c.counterparty_count)}
          hint="distinct addresses"
          className={KPI_TILE}
        />
        <FactCell
          label="Total sent"
          value={fmtTaoCompact(c.total_sent_tao)}
          hint="outflow"
          className={KPI_TILE}
        />
        <FactCell
          label="Total received"
          value={fmtTaoCompact(c.total_received_tao)}
          hint="inflow"
          className={KPI_TILE}
        />
        <FactCell
          label="Transfers scanned"
          value={formatNumber(c.transfers_scanned ?? 0)}
          hint={c.scan_capped ? "scan capped" : "in window"}
          className={KPI_TILE}
        />
      </FactStrip>
      <DataTable
        rows={rows}
        rowKey={(row) => row.address}
        caption="Counterparties"
        captionHidden
        link={RouterLink}
        source="account-counterparties"
        pageSize={20}
        columns={[
          {
            key: "address",
            label: "Address",
            value: (row) => row.address,
            render: (row) => (
              <AddressDisplay
                ss58={row.address}
                fallback={<>{row.address}</>}
                linkToAccount={row.address !== ss58}
              />
            ),
          },
          {
            key: "sent",
            label: "Sent",
            kind: "number",
            sortable: true,
            value: (row) => row.sent_tao,
            format: fmtStakeCell,
          },
          {
            key: "received",
            label: "Received",
            kind: "number",
            sortable: true,
            value: (row) => row.received_tao,
            format: fmtStakeCell,
          },
          {
            key: "net",
            label: "Net flow",
            kind: "number",
            sortable: true,
            value: (row) => row.net_tao,
            render: (row) =>
              row.net_tao == null ? (
                <span className="text-ink-muted">—</span>
              ) : (
                <span className={row.net_tao >= 0 ? "text-health-ok" : "text-health-warn-text"}>
                  {row.net_tao >= 0 ? "+" : ""}
                  {formatNumber(row.net_tao)} τ
                </span>
              ),
          },
          {
            key: "transfers",
            label: "Transfers",
            kind: "number",
            sortable: true,
            value: (row) => row.transfer_count ?? 0,
            format: fmtCount,
          },
          {
            key: "last_block",
            label: "Last block",
            kind: "link",
            align: "right",
            sortable: true,
            value: (row) => row.last_block,
            format: fmtBlock,
            href: (row) => (row.last_block != null ? `/blocks/${row.last_block}` : undefined),
          },
        ]}
      />
    </AnalyticsSection>
  );
}

// A u64 proportion is delivered as a 0..1 fraction; show it as a compact percent.
function fmtProportionPct(f: number | null): string {
  if (f == null || !Number.isFinite(f)) return "—";
  return `${(f * 100).toFixed(1)}%`;
}

type DelegationRow = {
  netuid: number;
  counterpart: string;
  proportion_fraction: number | null;
};

function flattenDelegation(subnets: AccountDelegationSubnet[] | null): DelegationRow[] {
  if (!Array.isArray(subnets)) return [];
  const rows: DelegationRow[] = [];
  for (const subnet of subnets) {
    for (const entry of subnet.entries) {
      rows.push({
        netuid: subnet.netuid,
        counterpart: entry.counterpart,
        proportion_fraction: entry.proportion_fraction,
      });
    }
  }
  return rows.sort((a, b) => a.netuid - b.netuid || a.counterpart.localeCompare(b.counterpart));
}

type DelegationStatus =
  | { kind: "pending" }
  | { kind: "empty" }
  | {
      kind: "ready";
      childRows: DelegationRow[];
      parentRows: DelegationRow[];
      childUnavailable: boolean;
      parentUnavailable: boolean;
    };

// Single status derivation so the section body only branches once
// (closed-PR feedback: overlapping pending/empty checks were hard to trace).
function deriveDelegationStatus(
  childrenResult: { isPending: boolean; isError: boolean },
  parentsResult: { isPending: boolean; isError: boolean },
  childrenData: AccountDelegationGraph | undefined,
  parentsData: AccountDelegationGraph | undefined,
): DelegationStatus {
  if ((childrenResult.isPending && !childrenData) || (parentsResult.isPending && !parentsData)) {
    return { kind: "pending" };
  }
  const childRows = flattenDelegation(childrenData?.subnets ?? null);
  const parentRows = flattenDelegation(parentsData?.subnets ?? null);
  // HTTP error OR `subnets: null` = live RPC didn't answer for that side.
  const childUnavailable = childrenResult.isError || childrenData?.subnets === null;
  const parentUnavailable = parentsResult.isError || parentsData?.subnets === null;
  if (
    !childUnavailable &&
    !parentUnavailable &&
    childRows.length === 0 &&
    parentRows.length === 0
  ) {
    return { kind: "empty" };
  }
  return { kind: "ready", childRows, parentRows, childUnavailable, parentUnavailable };
}

/**
 * Visual edge list — proportion bar + compact SN/hotkey row.
 * Avoids multi-word table headers that wrap on mobile (#7226/#7263 closes).
 */
function DelegationEdgeList({ ss58, rows }: { ss58: string; rows: DelegationRow[] }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded border border-border/80">
      {rows.map((r, i) => {
        const pct =
          r.proportion_fraction != null && Number.isFinite(r.proportion_fraction)
            ? Math.max(0, Math.min(1, r.proportion_fraction))
            : null;
        return (
          <div
            key={`${r.netuid}-${r.counterpart}-${i}`}
            className="flex items-center gap-3 px-4 py-3"
          >
            <Link
              to="/subnets/$netuid"
              params={{ netuid: r.netuid }}
              className="shrink-0 whitespace-nowrap text-11 text-ink hover:text-accent hover:underline"
            >
              SN{r.netuid}
            </Link>
            <div className="min-w-0 flex-1 truncate text-11 text-ink-muted" title={r.counterpart}>
              <AddressDisplay
                ss58={r.counterpart}
                fallback={<>{r.counterpart}</>}
                linkToAccount={r.counterpart !== ss58}
                compact
                valueClassName="truncate min-w-0"
              />
            </div>
            <div className="flex w-28 shrink-0 items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded bg-surface">
                <div
                  className="h-full rounded bg-accent"
                  style={{ width: `${pct == null ? 0 : pct * 100}%` }}
                />
              </div>
              <span className="w-11 whitespace-nowrap text-right text-11 tabular-nums text-ink">
                {fmtProportionPct(r.proportion_fraction)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DelegationSide({
  label,
  ss58,
  rows,
  unavailable,
  error,
  onRetry,
  emptyTitle,
  emptyDescription,
  unavailableContext,
}: {
  label: string;
  ss58: string;
  rows: DelegationRow[];
  unavailable: boolean;
  error: unknown;
  onRetry: () => void;
  emptyTitle: string;
  emptyDescription: string;
  unavailableContext: string;
}) {
  return (
    <div>
      <h3 className="mb-2 whitespace-nowrap text-11 text-ink-muted">{label}</h3>
      {unavailable ? (
        <ErrorState error={error} onRetry={onRetry} context={unavailableContext} />
      ) : rows.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <DelegationEdgeList ss58={ss58} rows={rows} />
      )}
    </div>
  );
}

// #6723 (child-hotkey epic #6721): live stake-weight delegation graph.
// Soft-hides for cold wallets; preserves null-vs-[] tri-state per side.
function AccountDelegationSection({ ss58 }: { ss58: string }) {
  const childrenResult = useQuery(accountChildrenQuery(ss58));
  const parentsResult = useQuery(accountParentsQuery(ss58));
  const childrenData = childrenResult.data?.data;
  const parentsData = parentsResult.data?.data;
  const status = deriveDelegationStatus(childrenResult, parentsResult, childrenData, parentsData);

  if (status.kind === "pending") {
    return <AccountFeedSectionSkeleton id="delegation" title="Delegation" />;
  }
  if (status.kind === "empty") return null;

  const { childRows, parentRows, childUnavailable, parentUnavailable } = status;
  const edgeCount = childRows.length + parentRows.length;

  return (
    <AnalyticsSection
      id="delegation"
      name="Delegation"
      footnote="Live child/parent-hotkey stake-weight edges from /api/v1/accounts/{ss58}/children and /parents (ChildKeys/ParentKeys, KV-cached). Each row is one edge and its share on that subnet."
      controls={
        edgeCount > 0 ? (
          <SectionBadge tone="accent">{formatNumber(edgeCount)} edges</SectionBadge>
        ) : null
      }
    >
      <FactStrip variant="grid">
        <FactCell
          label="Children"
          value={childUnavailable ? "—" : formatNumber(childRows.length)}
          hint="delegated to"
          className={KPI_TILE}
        />
        <FactCell
          label="Parents"
          value={parentUnavailable ? "—" : formatNumber(parentRows.length)}
          hint="delegating in"
          className={KPI_TILE}
        />
        <FactCell
          label="Subnets"
          value={formatNumber(new Set([...childRows, ...parentRows].map((r) => r.netuid)).size)}
          hint="with an edge"
          className={KPI_TILE}
        />
      </FactStrip>

      <div className="grid gap-6 lg:grid-cols-2">
        <DelegationSide
          label="Children"
          ss58={ss58}
          rows={childRows}
          unavailable={childUnavailable}
          error={childrenResult.error}
          onRetry={() => void childrenResult.refetch()}
          emptyTitle="No children"
          emptyDescription="This account delegates stake-weight to no child hotkeys."
          unavailableContext="child hotkeys"
        />
        <DelegationSide
          label="Parents"
          ss58={ss58}
          rows={parentRows}
          unavailable={parentUnavailable}
          error={parentsResult.error}
          onRetry={() => void parentsResult.refetch()}
          emptyTitle="No parents"
          emptyDescription="No parent hotkeys delegate stake-weight to this account."
          unavailableContext="parent hotkeys"
        />
      </div>
    </AnalyticsSection>
  );
}

function ownershipRoleLabel(role: string | null): string {
  if (role === "gained_ownership") return "Gained";
  if (role === "lost_ownership") return "Lost";
  return "—";
}

function EntityLabelCard({ label }: { label: AccountEntityLabel }) {
  return (
    <div className={KPI_TILE}>
      <div className="flex flex-wrap items-center gap-2">
        <Tag className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="min-w-0 truncate font-semibold text-ink">{label.name ?? "Unnamed"}</span>
        {label.category ? (
          <span className="shrink-0 whitespace-nowrap rounded border border-border/70 px-1.5 py-0.5 text-13 text-ink-muted">
            {label.category}
          </span>
        ) : null}
      </div>
      {label.notes ? <p className="mt-2 text-13 text-ink-muted">{label.notes}</p> : null}
      {label.source_urls.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-3">
          {label.source_urls.map((url, i) => (
            <ExternalLink
              key={`${url}-${i}`}
              href={url}
              className="text-10 text-accent-text hover:underline"
            >
              source{label.source_urls.length > 1 ? ` ${i + 1}` : ""}
            </ExternalLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// #6740: community entity labels + SubnetOwnerChanged ownership ties.
// Soft-hides when both lists are empty.
function AccountEntitiesSection({ ss58 }: { ss58: string }) {
  const result = useQuery(accountEntitiesQuery(ss58));
  const e = result.data?.data;

  if (result.isPending && !e) {
    return <AccountFeedSectionSkeleton id="entities" title="Entity" />;
  }
  if (result.isError) {
    return (
      <AnalyticsSection id="entities" name="Entity">
        <ErrorState
          error={result.error}
          onRetry={() => void result.refetch()}
          context="entity labels"
        />
      </AnalyticsSection>
    );
  }
  const labels: AccountEntityLabel[] = e?.labels ?? [];
  const ties: AccountOwnershipTie[] = e?.ownership_ties ?? [];
  if (!e || (labels.length === 0 && ties.length === 0)) return null;

  return (
    <AnalyticsSection
      id="entities"
      name="Entity"
      footnote="Community labels and subnet-ownership ties from /api/v1/accounts/{ss58}/entities. Ownership ties are automatic SubnetOwnerChanged transfers only (not genesis ownership)."
      controls={
        <SectionBadge tone="accent">{formatNumber(labels.length + ties.length)}</SectionBadge>
      }
    >
      {labels.length > 0 ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-2">
          {labels.map((label, i) => (
            <EntityLabelCard key={`${label.name ?? "label"}-${i}`} label={label} />
          ))}
        </div>
      ) : null}

      {ties.length > 0 ? (
        <>
          <h3 className="mb-2 whitespace-nowrap text-11 text-ink-muted">Ownership</h3>
          <DataTable
            rows={ties}
            rowKey={(row) => `${row.netuid}-${row.block_number}`}
            caption="Subnet ownership ties"
            captionHidden
            link={RouterLink}
            source="account-ownership-ties"
            columns={[
              {
                key: "netuid",
                label: "SN",
                sortable: true,
                value: (row) => row.netuid,
                render: (row) =>
                  row.netuid != null ? (
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: row.netuid }}
                      className="text-ink hover:text-accent hover:underline"
                    >
                      SN{row.netuid}
                    </Link>
                  ) : (
                    <span className="text-ink-muted">—</span>
                  ),
              },
              {
                key: "role",
                label: "Role",
                value: (row) => ownershipRoleLabel(row.role),
                render: (row) => (
                  <span
                    className={
                      row.role === "gained_ownership"
                        ? "text-health-ok"
                        : row.role === "lost_ownership"
                          ? "text-health-warn-text"
                          : "text-ink-muted"
                    }
                  >
                    {ownershipRoleLabel(row.role)}
                  </span>
                ),
              },
              {
                key: "block",
                label: "Block",
                kind: "link",
                align: "right",
                sortable: true,
                value: (row) => row.block_number,
                format: fmtBlock,
                href: (row) =>
                  row.block_number != null ? `/blocks/${row.block_number}` : undefined,
              },
              {
                key: "when",
                label: "When",
                kind: "time",
                align: "right",
                sortable: true,
                value: (row) => row.observed_at,
              },
            ]}
          />
        </>
      ) : null}
    </AnalyticsSection>
  );
}

// The route's own published windows (#10994).
const STAKE_FLOW_WINDOWS = QUERY_PARAMETER_ENUMS["/api/v1/accounts/{ss58}/stake-flow"].window;

/** A predicate, so the check NARROWS. `(X as readonly string[]).includes(v)`
 *  answers the question and then throws the answer away, leaving `v` a string
 *  that only an assertion could pass to a union-typed setter. */
function isStakeFlowWindow(value: string): value is (typeof STAKE_FLOW_WINDOWS)[number] {
  return STAKE_FLOW_WINDOWS.some((window) => window === value);
}

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
      onChange={(v) => setWindow(isStakeFlowWindow(v) ? v : "30d")}
      options={STAKE_FLOW_WINDOWS.map((w) => ({ value: w, label: w }))}
    />
  );

  if (result.isPending && !f) {
    return <AccountFeedSectionSkeleton id="stake-flow" title="Stake flow" subtitle={SUBTITLE} />;
  }
  if (result.isError) {
    return (
      <AnalyticsSection
        id="stake-flow"
        name="Stake flow"
        question={SUBTITLE}
        controls={windowControl}
      >
        <ErrorState
          error={result.error}
          onRetry={() => void result.refetch()}
          context="stake flow"
        />
      </AnalyticsSection>
    );
  }

  const subnets: AccountStakeFlowSubnet[] = f?.subnets ?? [];
  const netFlow = f?.net_flow_tao ?? null;
  const netStr =
    netFlow == null ? "—" : `${netFlow >= 0 ? "+" : "−"}${fmtTaoCompact(Math.abs(netFlow))}`;
  // Rail widths are unsigned (value / cap), so bar the always-≥0 gross flow
  // and surface each row's direction as a label in the table alongside.
  const bars = [...subnets]
    .filter((s) => (s.gross_flow_tao ?? 0) > 0)
    .sort((a, b) => (b.gross_flow_tao ?? 0) - (a.gross_flow_tao ?? 0))
    .slice(0, 12)
    .map((s) => ({ label: `SN${s.netuid}`, value: s.gross_flow_tao ?? 0 }));

  return (
    <AnalyticsSection
      id="stake-flow"
      name="Stake flow"
      question={SUBTITLE}
      footnote="Per-account staking behavior from /api/v1/accounts/{ss58}/stake-flow — net vs gross TAO flow, a direction label (accumulating / exiting / churning / idle), concentration, and the per-subnet stake / unstake breakdown over the window."
      controls={windowControl}
    >
      <FactStrip variant="grid">
        <FactCell
          label="Net flow"
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
        <FactCell
          label="Gross flow"
          value={fmtTaoCompact(f?.gross_flow_tao)}
          hint="staked + unstaked"
          className={KPI_TILE}
        />
        <FactCell
          label="Direction"
          value={<span className={stakeFlowDirClass(f?.direction)}>{f?.direction ?? "—"}</span>}
          hint={
            f?.concentration != null
              ? `${(f.concentration * 100).toFixed(0)}% concentrated`
              : undefined
          }
          className={KPI_TILE}
        />
        <FactCell
          label="Dominant subnet"
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
      </FactStrip>

      {bars.length > 0 ? (
        <div className="mb-4">
          <div className="mb-3 text-13 text-ink-muted">gross flow by subnet (τ)</div>
          <RankedRails
            items={railItems(bars)}
            formatValue={formatTao}
            ariaLabel="Gross stake flow by subnet"
          />
        </div>
      ) : null}

      <DataTable
        rows={[...subnets].sort((a, b) => (b.gross_flow_tao ?? 0) - (a.gross_flow_tao ?? 0))}
        rowKey={(row) => String(row.netuid)}
        caption="Stake flow by subnet"
        captionHidden
        link={RouterLink}
        source="account-stake-flow"
        pageSize={20}
        rowHref={(row) => `/subnets/${row.netuid}`}
        empty={
          <EmptyState
            title="No stake flow in this window"
            description={`No stake or unstake flow recorded for this account over the ${f?.window ?? window} window.`}
          />
        }
        columns={[
          {
            key: "netuid",
            label: "Subnet",
            sortable: true,
            value: (row) => row.netuid,
            format: (value) => `SN${String(value)}`,
          },
          {
            key: "direction",
            label: "Direction",
            value: (row) => row.direction,
            render: (row) => (
              <span className={stakeFlowDirClass(row.direction)}>{row.direction ?? "—"}</span>
            ),
          },
          {
            key: "net_flow",
            label: "Net flow",
            kind: "number",
            sortable: true,
            value: (row) => row.net_flow_tao,
            render: (row) =>
              row.net_flow_tao == null ? (
                <span className="text-ink-muted">—</span>
              ) : (
                <span
                  className={row.net_flow_tao >= 0 ? "text-health-ok" : "text-health-warn-text"}
                >
                  {row.net_flow_tao >= 0 ? "+" : "−"}
                  {fmtStake(Math.abs(row.net_flow_tao))}
                </span>
              ),
          },
          {
            key: "gross_flow",
            label: "Gross flow",
            kind: "number",
            sortable: true,
            value: (row) => row.gross_flow_tao,
            format: fmtStakeCell,
          },
          {
            key: "events",
            label: "Events",
            kind: "number",
            sortable: true,
            value: (row) => (row.stake_events ?? 0) + (row.unstake_events ?? 0),
            format: fmtCount,
          },
        ]}
      />
    </AnalyticsSection>
  );
}

// #8358: the detail-page template's "each tab's first page ≤25 rows behind
// the standard Load-more" budget. A top validator can carry 100+ positions --
// this table had no cap before the template applied, which is fine when it's
// the whole page but not once it's one entry in a tab a visitor expects to
// stay short.
const POSITIONS_PAGE_SIZE = 25;

function AccountPortfolioSection({ ss58 }: { ss58: string }) {
  const result = useQuery(accountPortfolioQuery(ss58));
  const p = result.data?.data;

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
      <AnalyticsSection
        id="portfolio"
        name="Portfolio"
        question="Cross-subnet neuron positions for this account: per-subnet stake, emission, and role, with an aggregate stake and yield summary."
      >
        <ErrorState
          error={result.error}
          onRetry={() => void result.refetch()}
          context="the portfolio"
        />
      </AnalyticsSection>
    );
  }
  const positions = p?.positions ?? [];
  if (!p || positions.length === 0) return null;

  return (
    <AnalyticsSection
      id="portfolio"
      name="Portfolio"
      question="Cross-subnet neuron positions for this account: per-subnet stake, emission, and role, with an aggregate stake and yield summary."
      footnote="The account's registered neurons across every subnet, from /api/v1/accounts/{ss58}/portfolio — total stake and emission, the validator / miner split, and the per-subnet breakdown."
      controls={<SectionBadge tone="accent">{formatNumber(p.subnet_count)} subnets</SectionBadge>}
    >
      <FactStrip variant="grid">
        <FactCell
          label="Positions"
          value={formatNumber(p.position_count)}
          hint={`across ${formatNumber(p.subnet_count)} subnets`}
          className={KPI_TILE}
        />
        <FactCell
          label="Total stake"
          value={fmtTaoCompact(p.total_stake_tao)}
          hint={`${formatNumber(p.validator_count)} val / ${formatNumber(p.miner_count)} min`}
          className={KPI_TILE}
        />
        <FactCell
          label="Total emission"
          value={fmtTaoCompact(p.total_emission_tao)}
          hint="summed across positions"
          className={KPI_TILE}
        />
        <FactCell
          label="Overall yield"
          value={p.overall_yield != null ? p.overall_yield.toExponential(2) : "—"}
          hint="return rate"
          className={KPI_TILE}
        />
      </FactStrip>
      {/* Per-position drill-down (#4329/6.4 -- the "Alpha Holdings chart"):
          activating a row expands its history in place rather than navigating
          away, so a viewer can compare several positions without losing the
          portfolio table. */}
      <DataTable
        rows={positions}
        rowKey={(row) => `${row.netuid}-${row.uid ?? "x"}`}
        caption="Portfolio positions"
        captionHidden
        link={RouterLink}
        source="account-portfolio"
        pageSize={POSITIONS_PAGE_SIZE}
        expand={(row) => <AccountPositionHistoryChart ss58={ss58} netuid={row.netuid} />}
        columns={[
          {
            key: "netuid",
            label: "Subnet",
            sortable: true,
            value: (row) => row.netuid,
            format: (value) => `SN${String(value)}`,
          },
          {
            key: "role",
            label: "Role",
            value: (row) => row.role,
            render: (row) =>
              row.role === "validator" ? (
                <span className="text-health-ok">validator</span>
              ) : row.role === "miner" ? (
                <span className="text-chart-1">miner</span>
              ) : (
                <span className="text-ink-muted">—</span>
              ),
          },
          {
            key: "stake",
            label: "Stake",
            kind: "number",
            sortable: true,
            value: (row) => row.stake_alpha,
            format: (_value, row) => fmtPositionStake(row.stake_alpha, row.netuid),
          },
          {
            key: "emission",
            label: "Emission",
            kind: "number",
            sortable: true,
            value: (row) => row.emission_alpha,
            format: (_value, row) => fmtPositionStake(row.emission_alpha, row.netuid),
          },
          {
            key: "incentive",
            label: "Incentive",
            kind: "number",
            sortable: true,
            value: (row) => row.incentive,
            format: fmtCount,
          },
        ]}
      />
    </AnalyticsSection>
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
      <AnalyticsSection id="identity" name="Identity" question={SUBTITLE}>
        <ErrorState
          error={result.error}
          onRetry={() => void result.refetch()}
          context="the identity"
        />
      </AnalyticsSection>
    );
  }
  if (!identity || !identity.has_identity) return null;

  return (
    <AnalyticsSection
      id="identity"
      name="Identity"
      question={SUBTITLE}
      footnote="GET /api/v1/accounts/{ss58}/identity — the coldkey's own on-chain identity, distinct from subnet identity and the validator directory's coldkey-identity join."
    >
      <div className="rounded border border-border/80 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-display text-16 font-semibold text-ink-strong">
            {identity.name ?? "Unnamed identity"}
          </span>
          {identity.captured_at ? (
            <span className="text-11 text-ink-muted">
              captured <TimeAgo at={identity.captured_at} />
            </span>
          ) : null}
        </div>
        {identity.description ? (
          <p className="mt-2 text-13 text-ink-muted">{identity.description}</p>
        ) : null}
        {identity.url || identity.github || identity.discord || identity.image ? (
          <div className="mt-3 flex flex-wrap gap-3 text-11">
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
          <p className="mt-2 text-11 text-ink-muted">{identity.additional}</p>
        ) : null}
      </div>
      <AccountIdentityTimeline ss58={ss58} />
    </AnalyticsSection>
  );
}

/**
 * Every earlier revision of this account's identity (#10517).
 *
 * INSIDE the Identity section rather than a section of its own: it is the same
 * subject at an earlier time, and a reader comparing "what does this account
 * claim now" against "what did it claim before" wants them adjacent. It also
 * renders only when the account HAS an identity, because the parent returns
 * null otherwise -- a history panel above an account that never registered one
 * would be a heading over a permanent empty state.
 *
 * WHY THIS EXISTS AT ALL. `/api/v1/accounts/{ss58}/identity-history` has been
 * published since #1647's account sibling and rendered nowhere. It passed
 * `validate:ui-route-coverage` at a ceiling of zero because that check matches
 * route strings against a blob that includes `content/docs`, and the route's
 * only occurrence anywhere in apps/ui was a row in `docs/accounts.mdx`. The
 * gate could not tell a documentation table from a consumer.
 *
 * NOT SUSPENSE. The parent already resolves the identity read; making this one
 * suspend would hold the whole section on a secondary timeline that is empty
 * for most accounts (630 revisions across 522 identities, so the median account
 * with an identity has one and no history worth showing).
 */
function AccountIdentityTimeline({ ss58 }: { ss58: string }) {
  const result = useQuery(accountIdentityHistoryQuery(ss58));
  const entries = result.data?.data.entries ?? [];

  // A FAILED READ IS SILENT HERE, deliberately, and it is the one place on this
  // page where that is right: the current identity above is already rendered
  // and correct, and replacing a supplementary timeline with an error card
  // would report the page as broken when one optional enrichment did not load.
  if (result.isPending || result.isError || entries.length === 0) return null;

  return (
    <div className="mt-3">
      <h3 className="text-13 mb-2 text-ink-muted">Previous revisions ({entries.length})</h3>
      <ol className="space-y-2">
        {entries.map((entry) => (
          <li key={entry.identity_hash} className="rounded border border-border bg-card p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-display text-13 font-semibold text-ink-strong">
                {entry.name ?? "Unnamed"}
              </span>
              <span className="text-11 text-ink-muted">
                {entry.observed_at ? <TimeAgo at={entry.observed_at} /> : "unknown time"}
              </span>
            </div>
            {entry.description ? (
              <p className="mt-1 text-13 text-ink-muted">{entry.description}</p>
            ) : null}
            {entry.url || entry.github || entry.discord ? (
              <div className="mt-1.5 flex flex-wrap gap-3 text-13">
                {entry.url ? (
                  <ExternalLink href={entry.url} className="text-accent-text hover:underline">
                    website
                  </ExternalLink>
                ) : null}
                {entry.github ? (
                  <ExternalLink href={entry.github} className="text-accent-text hover:underline">
                    github
                  </ExternalLink>
                ) : null}
                {entry.discord ? <span className="text-ink-muted">{entry.discord}</span> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
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
      <AnalyticsSection
        id="teardown"
        name="Teardown activity"
        question={`Axon endpoint removals (AxonInfoRemoved) for this account over the trailing ${windowLabel} window.`}
      >
        <ErrorState
          error={result.error}
          onRetry={() => void result.refetch()}
          context="teardown activity"
        />
      </AnalyticsSection>
    );
  }

  const removals = card?.total_removals ?? 0;
  const distinctSubnets = card?.subnet_count ?? 0;
  if (removals === 0 && distinctSubnets === 0) return null;

  return (
    <AnalyticsSection
      id="teardown"
      name="Teardown activity"
      question={`Axon endpoint removals (AxonInfoRemoved) for this account over the trailing ${windowLabel} window.`}
      footnote="The account-level companion to subnet axon-removal activity — counts how often this hotkey removed an announced axon endpoint, and on how many distinct subnets."
      controls={<SectionBadge tone="accent">{windowLabel}</SectionBadge>}
    >
      <FactStrip>
        <FactCell
          label="Removals"
          value={formatNumber(removals)}
          hint={`AxonInfoRemoved · ${windowLabel}`}
          className={KPI_TILE}
        />
        <FactCell
          label="Distinct subnets"
          value={formatNumber(distinctSubnets)}
          hint="subnets with teardown"
          className={KPI_TILE}
        />
      </FactStrip>
    </AnalyticsSection>
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
      <AnalyticsSection
        id="registrations"
        name="Registration activity"
        question={`Neuron registrations (NeuronRegistered) for this account over the trailing ${windowLabel} window.`}
      >
        <ErrorState
          error={result.error}
          onRetry={() => void result.refetch()}
          context="registration activity"
        />
      </AnalyticsSection>
    );
  }

  const registrations = card?.total_registrations ?? 0;
  const distinctSubnets = card?.subnet_count ?? 0;
  if (registrations === 0 && distinctSubnets === 0) return null;

  return (
    <AnalyticsSection
      id="registrations"
      name="Registration activity"
      question={`Neuron registrations (NeuronRegistered) for this account over the trailing ${windowLabel} window.`}
      footnote="The account-level companion to subnet registration activity — counts how often this hotkey was registered into a subnet, and on how many distinct subnets."
      controls={<SectionBadge tone="accent">{windowLabel}</SectionBadge>}
    >
      <FactStrip>
        <FactCell
          label="Registrations"
          value={formatNumber(registrations)}
          hint={`NeuronRegistered · ${windowLabel}`}
          className={KPI_TILE}
        />
        <FactCell
          label="Distinct subnets"
          value={formatNumber(distinctSubnets)}
          hint="subnets with registration"
          className={KPI_TILE}
        />
      </FactStrip>
    </AnalyticsSection>
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
      <AnalyticsSection
        id="deregistrations"
        name="Deregistration activity"
        question={`Neuron deregistrations (NeuronDeregistered) for this account over the trailing ${windowLabel} window.`}
      >
        <ErrorState
          error={result.error}
          onRetry={() => void result.refetch()}
          context="deregistration activity"
        />
      </AnalyticsSection>
    );
  }

  const deregistrations = card?.total_deregistrations ?? 0;
  const distinctSubnets = card?.subnet_count ?? 0;
  if (deregistrations === 0 && distinctSubnets === 0) return null;

  return (
    <AnalyticsSection
      id="deregistrations"
      name="Deregistration activity"
      question={`Neuron deregistrations (NeuronDeregistered) for this account over the trailing ${windowLabel} window.`}
      footnote="The account-level companion to subnet deregistration activity — counts how often this hotkey was deregistered (evicted) from a subnet, and on how many distinct subnets."
      controls={<SectionBadge tone="accent">{windowLabel}</SectionBadge>}
    >
      <FactStrip>
        <FactCell
          label="Deregistrations"
          value={formatNumber(deregistrations)}
          hint={`NeuronDeregistered · ${windowLabel}`}
          className={KPI_TILE}
        />
        <FactCell
          label="Distinct subnets"
          value={formatNumber(distinctSubnets)}
          hint="subnets with deregistration"
          className={KPI_TILE}
        />
      </FactStrip>
    </AnalyticsSection>
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
      <AnalyticsSection
        id="weight-setting"
        name="Weight-setting activity"
        question={`Validator WeightsSet events for this account over the trailing ${windowLabel} window.`}
      >
        <ErrorState
          error={result.error}
          onRetry={() => void result.refetch()}
          context="weight-setting activity"
        />
      </AnalyticsSection>
    );
  }

  // #8252: hide entirely rather than render a framed "No weight-setting
  // activity" panel. Weight-setting is structurally irrelevant to a coldkey
  // or a non-validator hotkey -- an empty box explaining it doesn't apply is
  // exactly the noise the redesign removes. Matches the self-hiding
  // convention the registration/deregistration/teardown sections already use.
  if (totalSets === 0 && subnets.length === 0) return null;

  return (
    <AnalyticsSection
      id="weight-setting"
      name="Weight-setting activity"
      question={`Validator WeightsSet events for this account over the trailing ${windowLabel} window — per-subnet breakdown when this hotkey submits weights.`}
      footnote="The account-level companion to subnet weight-setter leaderboards — keyed on the validator hotkey submitting its weight vector."
      controls={<SectionBadge tone="accent">{windowLabel}</SectionBadge>}
    >
      {
        <>
          <FactStrip>
            <FactCell
              label="Weight sets"
              value={formatNumber(totalSets)}
              hint={`WeightsSet · ${windowLabel}`}
              className={KPI_TILE}
            />
            <FactCell
              label="Distinct subnets"
              value={formatNumber(card?.subnet_count ?? subnets.length)}
              hint="subnets with weight sets"
              className={KPI_TILE}
            />
          </FactStrip>
          <DataTable
            rows={subnets}
            rowKey={(row) => String(row.netuid)}
            caption="Weight sets by subnet"
            captionHidden
            link={RouterLink}
            source="account-weight-setting"
            rowHref={(row) => `/subnets/${row.netuid}`}
            columns={[
              {
                key: "netuid",
                label: "Subnet",
                sortable: true,
                value: (row) => row.netuid,
                format: (value) => `SN${String(value)}`,
              },
              {
                key: "weight_sets",
                label: "Weight sets",
                kind: "number",
                sortable: true,
                value: (row) => row.weight_sets,
                format: fmtCount,
              },
              {
                key: "last_set",
                label: "Last set",
                kind: "time",
                align: "right",
                sortable: true,
                value: (row) => row.last_set_at,
              },
            ]}
          />
        </>
      }
    </AnalyticsSection>
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
const endpointAnnouncementsTitle = <span className="">Endpoint announcements</span>;

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
      <AnalyticsSection
        id="endpoint-announcements"
        name={endpointAnnouncementsTitle}
        question={`Axon endpoint (AxonServed) and Prometheus telemetry (PrometheusServed) announcements for this account over the trailing ${windowLabel} window.`}
      >
        <ErrorState
          error={servingResult.error ?? prometheusResult.error}
          onRetry={() => {
            void servingResult.refetch();
            void prometheusResult.refetch();
          }}
          context="endpoint announcement activity"
        />
      </AnalyticsSection>
    );
  }

  // Each source can fail independently while the other succeeds — the
  // combined section must not render the failed half's count as if it were
  // a genuine zero.
  const servingFailed = servingResult.isError && !serving;
  const prometheusFailed = prometheusResult.isError && !prometheus;
  const servingCount = serving?.total_announcements ?? 0;
  const prometheusCount = prometheus?.total_announcements ?? 0;
  // #8252: hide entirely rather than render a framed "No endpoint
  // announcements" panel — serving/Prometheus announcements are structurally
  // irrelevant to a coldkey or a non-miner hotkey. Note this is gated on
  // BOTH sources genuinely reporting zero (not on either having failed), so
  // a failed tier still renders the section and surfaces its own error rather
  // than silently vanishing as if the account had no activity.
  const isEmpty =
    !servingFailed && !prometheusFailed && servingCount === 0 && prometheusCount === 0;
  if (isEmpty) return null;

  return (
    <AnalyticsSection
      id="endpoint-announcements"
      name={endpointAnnouncementsTitle}
      question={`Axon endpoint (AxonServed) and Prometheus telemetry (PrometheusServed) announcements for this account over the trailing ${windowLabel} window.`}
      footnote="The account-level companion to subnet serving + prometheus activity — counts how often this hotkey announced axon and Prometheus endpoints."
      controls={<SectionBadge tone="accent">{windowLabel}</SectionBadge>}
    >
      {
        <FactStrip>
          <FactCell
            label="Axon serving"
            value={servingFailed ? "—" : formatNumber(servingCount)}
            hint={
              servingFailed
                ? "fetch failed · showing Prometheus only"
                : `AxonServed · ${windowLabel}`
            }
            className={KPI_TILE}
          />
          <FactCell
            label="Prometheus"
            value={prometheusFailed ? "—" : formatNumber(prometheusCount)}
            hint={
              prometheusFailed
                ? "fetch failed · showing Axon only"
                : `PrometheusServed · ${windowLabel}`
            }
            className={KPI_TILE}
          />
        </FactStrip>
      }
    </AnalyticsSection>
  );
}

/**
 * Cross-subnet footprint (#266) — the dedicated netuid-ordered /subnets feed
 * plus stake-by-subnet rails. Non-blocking: while the dedicated query loads
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
      <AnalyticsSection
        id="footprint"
        name="Subnet footprint"
        question="Current registrations across the indexed network, netuid-ordered, with stake distribution."
      >
        <ErrorState
          error={subnetsResult.error}
          onRetry={() => void subnetsResult.refetch()}
          context="the subnet footprint"
        />
      </AnalyticsSection>
    );
  }
  if (rows.length === 0) return null;

  const staked = rows
    .filter((r) => r.netuid != null && (r.stake_tao ?? 0) > 0)
    .slice(0, 12)
    .map((r) => ({ label: `SN${r.netuid}`, value: r.stake_tao ?? 0 }));

  return (
    <AnalyticsSection
      id="footprint"
      name="Subnet footprint"
      question="Current registrations across the indexed network, netuid-ordered, with stake distribution."
      controls={<SectionBadge>{formatNumber(rows.length)} subnets</SectionBadge>}
    >
      {staked.length > 0 ? (
        <div className="mb-4">
          <div className="mb-3 text-13 text-ink-muted">stake by subnet (τ)</div>
          <RankedRails
            items={railItems(staked)}
            formatValue={formatTao}
            ariaLabel="Stake by subnet"
          />
        </div>
      ) : null}
      {/* #8358: same "≤25 rows a page" budget as the portfolio table -- a top
          validator's registration footprint is as large as its position count
          (same account, same magnitude). #6428: below 640px the same five
          columns become one label/value card per subnet, so Permit and Active
          -- and with them this section's only route to a validator profile --
          stay reachable without a horizontal swipe. */}
      <DataTable
        rows={rows}
        rowKey={(row) => `${row.netuid}-${row.uid}`}
        caption="Subnet footprint"
        captionHidden
        link={RouterLink}
        source="account-footprint"
        pageSize={POSITIONS_PAGE_SIZE}
        columns={[
          {
            key: "netuid",
            label: "Subnet",
            sortable: true,
            value: (row) => row.netuid,
            render: (row) =>
              row.netuid != null ? (
                <Link
                  to="/subnets/$netuid"
                  params={{ netuid: row.netuid }}
                  // Same deep-link as SubnetPerformanceTable: this row already
                  // knows its uid, so land on the neuron card, not the overview.
                  search={subnetPositionSearch(row.uid)}
                  className="inline-flex items-center rounded border border-border bg-paper px-2.5 py-1 font-medium text-ink-strong transition-colors hover:border-accent/30 hover:text-accent"
                >
                  SN{row.netuid}
                </Link>
              ) : (
                "—"
              ),
          },
          {
            key: "uid",
            label: "UID",
            kind: "number",
            sortable: true,
            value: (row) => row.uid,
            format: fmtCount,
          },
          {
            key: "stake",
            label: "Stake",
            kind: "number",
            sortable: true,
            value: (row) => row.stake_tao,
            format: fmtStakeCell,
          },
          {
            key: "permit",
            label: "Permit",
            value: (row) => (row.validator_permit ? "validator" : null),
            render: (row) =>
              row.validator_permit ? (
                <ValidatorPermitBadge ss58={ss58} />
              ) : (
                <span className="text-ink-muted">—</span>
              ),
          },
          {
            key: "active",
            label: "Active",
            kind: "status",
            value: (row) => (row.active ? "active" : "idle"),
          },
        ]}
      />
    </AnalyticsSection>
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
      className="inline-flex shrink-0 rounded bg-health-ok/10 px-2 py-0.5 text-11 text-health-ok transition-colors hover:bg-health-ok/20"
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
  const search = useSearch({ from: "/accounts/$ss58" });
  const navigate = useNavigate({ from: "/accounts/$ss58" });
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
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
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
      <AnalyticsSection
        id="events"
        name="Chain events"
        footnote="Full first-party event feed for this account, newest first — filter by kind, page through history."
      >
        <ErrorState
          error={result.error}
          onRetry={() => void result.refetch()}
          context="chain events"
        />
      </AnalyticsSection>
    );
  }

  return (
    <AnalyticsSection
      id="events"
      name="Chain events"
      footnote="Full first-party event feed for this account, newest first — filter by kind, page through history."
      controls={
        kindOptions.length > 0 ? (
          <FilterChip
            ariaLabel="Filter by event kind"
            value={search.ev_kind ?? ""}
            onChange={(v) => setSearch({ ev_kind: v || undefined, ev_offset: undefined })}
            options={kindOptions.map((k) => ({ value: k.kind, label: k.kind }))}
          />
        ) : null
      }
    >
      {events.length > 0 ? (
        <DataTable
          rows={events}
          rowKey={(row) => `${row.block_number}-${row.event_index}`}
          caption="Chain events"
          captionHidden
          link={RouterLink}
          source="account-events"
          // Server-side offset paging, in the URL: the table only ever holds
          // one page, so it reports the window it knows about — the current
          // page plus one more when the feed says there is one.
          page={Math.floor(offset / limit) + 1}
          onPage={(next) => setSearch({ ev_offset: (next - 1) * limit || undefined })}
          pageSize={limit}
          total={offset + events.length + (hasNext ? 1 : 0)}
          columns={[
            {
              key: "block",
              label: "Block",
              sortable: true,
              value: (row) => row.block_number,
              format: fmtBlock,
              render: (row) =>
                row.block_number != null ? (
                  <Link
                    to="/blocks/$ref"
                    params={{ ref: String(row.block_number) }}
                    className="text-ink hover:text-accent hover:underline"
                  >
                    #{formatNumber(row.block_number)}
                  </Link>
                ) : (
                  "—"
                ),
            },
            {
              key: "kind",
              label: "Kind",
              value: (row) => eventKindLabel(row.event_kind),
            },
            {
              key: "netuid",
              label: "Subnet",
              kind: "link",
              value: (row) => row.netuid,
              format: (value) => (typeof value === "number" ? `SN${value}` : "—"),
              href: (row) => (row.netuid != null ? `/subnets/${row.netuid}` : undefined),
            },
            {
              key: "amount",
              label: "Amount",
              kind: "number",
              sortable: true,
              value: (row) => row.amount_tao,
              render: (row) => (
                <>
                  {row.amount_tao != null ? fmtStake(row.amount_tao) : "—"}
                  {/* #8369: what it was worth at the time, as secondary
                      text. Renders nothing for events that have no price.
                      #8602 adds the fiat leg beside it, which renders
                      nothing of its own for events predating the index. */}
                  <PriceAtTx
                    price={row.price_at_tx}
                    basis={row.price_basis}
                    blockNumber={row.block_number}
                    usd={row.usd_at_tx}
                  />
                </>
              ),
            },
            {
              key: "observed",
              label: "Observed",
              kind: "time",
              align: "right",
              sortable: true,
              value: (row) => row.observed_at,
            },
          ]}
        />
      ) : (
        <div className="space-y-3">
          <EmptyState
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
                className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-3.5 py-1.5 text-11 text-ink-muted hover:border-ink/30 hover:text-ink-strong"
              >
                <ChevronLeft className="size-3" /> Back to newest
              </button>
            </div>
          ) : null}
        </div>
      )}
    </AnalyticsSection>
  );
}
