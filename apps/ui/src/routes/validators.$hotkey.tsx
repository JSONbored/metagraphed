import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { Boxes, Coins, Gauge, Percent, TriangleAlert, Users, Zap } from "lucide-react";
import { useWallet } from "@/hooks/use-wallet";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, PageHeading, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EndpointSnippet } from "@/components/metagraphed/endpoint-snippet";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { PageHero, ShareButton, SectionAnchor, CopyableCode, StatTile } from "@jsonbored/ui-kit";
import { ValidatorHistoryChart } from "@/components/metagraphed/validator-history-chart";
import { ValidatorApyPanel } from "@/components/metagraphed/validator-apy-panel";
import { ValidatorIdentityChip } from "@/components/metagraphed/validator-identity-chip";
import { WatchValidatorAlert } from "@/components/metagraphed/watch-validator-alert";
import { StakeUnstakeModal } from "@/components/metagraphed/stake-unstake-modal";
import { TakeManagementModal } from "@/components/metagraphed/take-management-modal";
import {
  ValidatorNominatorsTable,
  type ValidatorNominatorsSearch,
} from "@/components/metagraphed/validator-nominators-table";
import { taoCompact, scoreStr } from "@/components/metagraphed/neuron-format";
import { validatorDetailQuery, validatorNominatorsQuery } from "@/lib/metagraphed/queries";
import { isValidSs58, ss58PathSegment } from "@/lib/metagraphed/accounts";
import { shortHash } from "@/lib/metagraphed/blocks";
import { formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";
import { hasValidatorIdentity } from "@/lib/metagraphed/validator-identity";
import { isUnrecognizedValidator } from "@/lib/metagraphed/validator-recognition";
import {
  annualizedDelegatorApyPct,
  formatApyPct,
  formatTakePct,
} from "@/lib/metagraphed/validator-apy";
import type { ValidatorDetailSubnet } from "@/lib/metagraphed/types";
import { subnetPositionSearch } from "@/lib/metagraphed/subnet-position-link";

const validatorDetailSearchSchema = z.object({
  window: fallback(z.enum(["7d", "30d", "90d"]), "30d").default("30d"),
  sort: fallback(z.enum(["net_staked", "gross_staked", "last_activity"]), "net_staked").default(
    "net_staked",
  ),
  limit: fallback(z.number().int().min(1).max(100), 20).default(20),
  offset: fallback(z.number().int().min(0), 0).default(0),
  coldkey: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/validators/$hotkey")({
  validateSearch: zodValidator(validatorDetailSearchSchema),
  head: ({ params }) => {
    const label = shortHash(params.hotkey) ?? params.hotkey;
    return {
      meta: [
        { title: `Validator ${label} — Metagraphed` },
        {
          name: "description",
          content: `Cross-subnet performance, nominators, and staking history for Bittensor validator ${label}.`,
        },
        { property: "og:title", content: `Validator ${label} — Metagraphed` },
        {
          property: "og:description",
          content: "Cross-subnet validator performance, nominators, and staking history.",
        },
      ],
    };
  },
  component: ValidatorDetailPage,
});

function ValidatorDetailPage() {
  const { hotkey } = Route.useParams();
  return (
    <AppShell>
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <ValidatorDetailGate hotkey={hotkey} />
        </Suspense>
      </QueryErrorBoundary>
    </AppShell>
  );
}

function ValidatorDetailGate({ hotkey }: { hotkey: string }) {
  if (!isValidSs58(hotkey)) {
    return (
      <>
        <PageHeading
          eyebrow="Explorer"
          title="Invalid hotkey"
          description="Validator hotkeys must be a valid ss58 (base58) string."
        />
        <EmptyState
          title="Invalid hotkey"
          description="Use a valid validator hotkey ss58 address."
          action={{ label: "Back to validators", href: "/validators" }}
        />
      </>
    );
  }
  return <ValidatorDetail hotkey={hotkey} />;
}

const TH = "px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted";

function SubnetPerformanceTable({
  hotkey,
  validatorName,
  subnets,
}: {
  hotkey: string;
  validatorName?: string;
  subnets: ValidatorDetailSubnet[];
}) {
  if (subnets.length === 0) {
    return (
      <EmptyState
        title="No active subnet memberships"
        description="This hotkey isn't currently registered as a validator on any subnet."
      />
    );
  }
  const sorted = [...subnets].sort((a, b) => (b.stake_tao ?? 0) - (a.stake_tao ?? 0));
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-surface/50">
          <tr>
            <th className={TH}>Subnet</th>
            <th className={`${TH} text-right`}>UID</th>
            <th className={`${TH} text-right`}>Stake τ</th>
            <th className={`${TH} text-right`}>Emission τ</th>
            <th className={`${TH} text-right`}>Dividends</th>
            <th className={`${TH} text-right`}>Val trust</th>
            <th className={`${TH} text-center`}>Permit</th>
            <th className={`${TH} text-right`}>Stake</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((s) => (
            <tr key={s.netuid} className="hover:bg-surface/40">
              <td className="px-3 py-2 font-mono text-[11px]">
                <Link
                  to="/subnets/$netuid"
                  params={{ netuid: s.netuid }}
                  // Deep-link straight to this row's neuron card rather than the
                  // subnet overview -- the uid is right here in the next cell, and
                  // subnets.$netuid.tsx already reads `tab`/`uid` to render it.
                  search={subnetPositionSearch(s.uid)}
                  className="text-ink-strong hover:text-accent hover:underline"
                >
                  SN{s.netuid}
                </Link>
              </td>
              <td className="px-3 py-2 text-right font-mono text-[12px] tabular-nums text-ink-muted">
                {s.uid}
              </td>
              <td className="px-3 py-2 text-right font-mono text-[12px] tabular-nums text-ink-strong">
                {taoCompact(s.stake_tao)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-[12px] tabular-nums text-ink">
                {taoCompact(s.emission_tao)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-[12px] tabular-nums text-ink">
                {scoreStr(s.dividends)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-[12px] tabular-nums text-ink-muted">
                {scoreStr(s.validator_trust)}
              </td>
              <td className="px-3 py-2 text-center">
                {s.validator_permit ? (
                  <span className="inline-flex items-center rounded border border-accent/40 bg-accent-surface px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-wider text-accent-text">
                    Yes
                  </span>
                ) : (
                  <span className="font-mono text-[10px] text-ink-subtle-text">—</span>
                )}
              </td>
              <td className="px-3 py-2 text-right">
                <StakeUnstakeModal
                  hotkey={hotkey}
                  netuid={s.netuid}
                  validatorName={validatorName}
                  trigger={(open) => (
                    <button
                      type="button"
                      onClick={open}
                      className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink-strong transition-colors hover:border-accent/50 hover:text-accent"
                    >
                      <Coins className="size-3 text-ink-muted" aria-hidden />
                      Stake
                    </button>
                  )}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function nominatorsQueryParams(search: ValidatorNominatorsSearch): Record<string, string | number> {
  const params: Record<string, string | number> = {
    window: search.window,
    sort: search.sort,
    limit: search.limit,
    offset: search.offset,
  };
  // Only a complete, valid ss58 is worth sending — the backend 400s on a partial
  // match, and a partial/invalid value updates on every keystroke, so gating here
  // keeps a mid-typing coldkey from ever reaching the API.
  if (search.coldkey && isValidSs58(search.coldkey)) params.coldkey = search.coldkey;
  return params;
}

function NominatorsSection({ hotkey }: { hotkey: string }) {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const setSearch = (patch: Partial<ValidatorNominatorsSearch>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never,
      // Patch in-page search/filter state only; do not scroll to top on each keystroke (#3691).
      resetScroll: false,
    });

  const normalizedSearch: ValidatorNominatorsSearch = {
    window: search.window,
    sort: search.sort,
    limit: search.limit,
    offset: search.offset,
    coldkey: search.coldkey,
  };

  return (
    <ValidatorNominatorsTable
      queryOptions={validatorNominatorsQuery(hotkey, nominatorsQueryParams(normalizedSearch))}
      search={normalizedSearch}
      setSearch={setSearch}
    />
  );
}

function ValidatorDetail({ hotkey }: { hotkey: string }) {
  const sourceRef = ss58PathSegment(hotkey);
  const detailRes = useSuspenseQuery(validatorDetailQuery(hotkey)).data;
  const detail = detailRes.data;
  const generatedAt = detailRes.meta?.generated_at ?? null;
  const identity = detail.coldkey_identity;
  const hasIdentity = hasValidatorIdentity(identity);
  const displayName =
    hasIdentity && identity?.name ? identity.name : (shortHash(hotkey, 8) ?? "Validator");
  const snapshotApy = annualizedDelegatorApyPct(
    detail.total_emission_tao,
    detail.total_stake_tao,
    detail.take,
  );
  // Take is network-wide, not subnet-scoped, so unlike the per-subnet Stake
  // action this belongs at the page level, not in SubnetPerformanceTable's
  // rows. Hidden entirely (not just internally blocked) until the connected
  // wallet is confirmed to be this validator's owning coldkey -- #5246's own
  // "only surfaced when..." requirement, not just a submit-time guard.
  const { wallet } = useWallet();
  const isOwner = !!wallet && !!detail.coldkey && wallet.address === detail.coldkey;

  return (
    <>
      <PageHero
        eyebrow="Explorer · validator"
        live
        title={displayName}
        description={
          <span className="block space-y-4">
            {/* With no declared operator identity the chip would only repeat the
                hotkey already shown as the title and in the copyable field
                below, so it's dropped when there's nothing extra to show (#5311). */}
            {hasIdentity ? (
              <span className="flex flex-wrap items-center gap-3">
                <ValidatorIdentityChip hotkey={hotkey} identity={identity} size={40} />
                <span className="text-[11px] text-ink-muted">
                  Operator identity is declared on the coldkey — not hotkey-specific (#5234).
                </span>
              </span>
            ) : null}
            <span className="block max-w-2xl text-sm text-ink-muted">
              Cross-subnet performance, nominators, and staking history for one Bittensor validator
              hotkey.
            </span>
            <span className="inline-flex max-w-full min-w-0 rounded-2xl border border-border/80 bg-card/80 px-3 py-2 shadow-[0_16px_40px_-32px_rgba(15,23,42,0.55)]">
              <CopyableCode value={hotkey} truncate={false} className="max-w-full" />
            </span>
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isOwner ? (
              <TakeManagementModal
                hotkey={hotkey}
                ownerColdkey={detail.coldkey}
                validatorName={hasIdentity ? displayName : undefined}
                trigger={(open) => (
                  <button
                    type="button"
                    onClick={open}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink-strong transition-colors hover:border-accent/50 hover:text-accent"
                  >
                    <Percent className="size-3 text-ink-muted" aria-hidden />
                    Manage take
                  </button>
                )}
              />
            ) : null}
            <ShareButton />
            {isStaleFreshness(generatedAt) ? (
              <StaleBanner
                compact
                generatedAt={generatedAt}
                refreshQueryKeys={[validatorDetailQuery(hotkey).queryKey]}
              />
            ) : null}
          </div>
        }
        caption="explorer / v1"
      />

      {/* #6430: the endpoint is schema-stable, so a mistyped or never-registered
          hotkey resolves to a zeroed aggregate and renders a page of zeros that
          looks exactly like a real validator holding nothing. Say so up front,
          above the tiles it explains. Deliberately a notice and not an
          EmptyState swap (the blocks/extrinsics treatment): the payload really
          is valid and the rest of the page stays useful for confirming the
          address you looked up. */}
      {isUnrecognizedValidator(detail) ? (
        <div
          role="status"
          className="mb-8 flex items-start gap-3 rounded-2xl border border-health-warn/40 bg-health-warn/5 px-4 py-3"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-health-warn" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink-strong">
              This hotkey isn&apos;t a registered validator
            </p>
            <p className="mt-1 max-w-2xl text-[13px] text-ink-muted">
              The address is a valid ss58, but it has never been seen validating on any subnet —
              every figure below reads zero for that reason, not because the validator is idle. It
              may be mistyped, or a coldkey rather than a hotkey.
            </p>
          </div>
        </div>
      ) : null}

      <div className="mb-12 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatTile
          icon={Coins}
          eyebrow="Total stake"
          value={taoCompact(detail.total_stake_tao)}
          // Root (netuid 0) is TAO-denominated with no price exposure; alpha
          // is the sum across every other subnet's own alpha token (#2550).
          hint={`Root ${taoCompact(detail.root_stake_tao)} · Alpha ${taoCompact(detail.alpha_stake_tao)}`}
          truncate={false}
          tone="accent"
          className="rounded-2xl border-accent/25 bg-card/95 p-5 shadow-[0_24px_80px_-52px_rgba(45,212,191,0.45)]"
        />
        <StatTile
          icon={Zap}
          eyebrow="Total emission"
          value={taoCompact(detail.total_emission_tao)}
          hint="across all subnets"
          className="rounded-2xl border-border/80 bg-card/95 p-5 shadow-[0_24px_80px_-58px_rgba(15,23,42,0.45)]"
        />
        <StatTile
          icon={Boxes}
          eyebrow="Active subnets"
          value={formatNumber(detail.subnet_count)}
          hint="validator memberships"
          className="rounded-2xl border-border/80 bg-card/95 p-5 shadow-[0_24px_80px_-58px_rgba(15,23,42,0.45)]"
        />
        <StatTile
          icon={Gauge}
          eyebrow="Avg validator trust"
          value={scoreStr(detail.avg_validator_trust)}
          hint="mean across subnets"
          className="rounded-2xl border-border/80 bg-card/95 p-5 shadow-[0_24px_80px_-58px_rgba(15,23,42,0.45)]"
        />
        <StatTile
          icon={Gauge}
          eyebrow="Max validator trust"
          value={scoreStr(detail.max_validator_trust)}
          hint="best subnet"
          className="rounded-2xl border-border/80 bg-card/95 p-5 shadow-[0_24px_80px_-58px_rgba(15,23,42,0.45)]"
        />
        <StatTile
          icon={Percent}
          eyebrow="Take rate"
          value={formatTakePct(detail.take)}
          hint="commission kept from delegators"
          className="rounded-2xl border-border/80 bg-card/95 p-5 shadow-[0_24px_80px_-58px_rgba(15,23,42,0.45)]"
        />
        <StatTile
          icon={Users}
          eyebrow="Nominators"
          value={detail.nominator_count != null ? formatNumber(detail.nominator_count) : "—"}
          hint="distinct coldkeys delegated"
          className="rounded-2xl border-border/80 bg-card/95 p-5 shadow-[0_24px_80px_-58px_rgba(15,23,42,0.45)]"
        />
        <StatTile
          icon={Zap}
          eyebrow="Est. APY"
          value={formatApyPct(snapshotApy)}
          hint="latest snapshot · net of take"
          truncate={false}
          className="rounded-2xl border-border/80 bg-card/95 p-5 shadow-[0_24px_80px_-58px_rgba(15,23,42,0.45)]"
        />
      </div>

      <SectionAnchor
        id="apy"
        title="Delegator yield (APY)"
        subtitle="7d / 30d / 90d windows from daily history"
        tone="accent"
      >
        <ValidatorApyPanel hotkey={hotkey} take={detail.take} generatedAt={detail.captured_at} />
      </SectionAnchor>

      <SectionAnchor id="subnets" title="Per-subnet performance" tone="accent">
        <SubnetPerformanceTable
          hotkey={hotkey}
          validatorName={hasIdentity ? displayName : undefined}
          subnets={detail.subnets}
        />
      </SectionAnchor>

      <SectionAnchor
        id="history"
        title="Stake & rewards over time"
        subtitle="Daily snapshots"
        tone="ink"
      >
        <ValidatorHistoryChart hotkey={hotkey} />
      </SectionAnchor>

      <SectionAnchor
        id="nominators"
        title="Nominators"
        subtitle="Derived from stake-delegation events"
        tone="muted"
      >
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <NominatorsSection hotkey={hotkey} />
          </Suspense>
        </QueryErrorBoundary>
      </SectionAnchor>

      <SectionAnchor
        id="watch"
        title="Watch this validator"
        subtitle="Alert on new delegations or stake, via the existing chain alert-triggers API."
        tone="accent"
      >
        <WatchValidatorAlert hotkey={hotkey} />
      </SectionAnchor>

      <SectionAnchor
        id="call"
        title="Call this endpoint"
        subtitle="Copy a ready-to-run request for this validator."
      >
        <EndpointSnippet
          rows={[
            { label: "summary", path: `/api/v1/validators/${sourceRef}` },
            { label: "nominators", path: `/api/v1/validators/${sourceRef}/nominators` },
            { label: "history", path: `/api/v1/validators/${sourceRef}/history` },
          ]}
        />
      </SectionAnchor>

      <ApiSourceFooter
        paths={[
          `/api/v1/validators/${sourceRef}`,
          `/api/v1/validators/${sourceRef}/nominators`,
          `/api/v1/validators/${sourceRef}/history`,
        ]}
      />
    </>
  );
}
