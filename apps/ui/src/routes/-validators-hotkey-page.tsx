import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Coins, Percent, TriangleAlert } from "lucide-react";
import { useWallet } from "@/hooks/use-wallet";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EndpointSnippet } from "@/components/metagraphed/endpoint-snippet";
import {
  Chip,
  AnalyticsSection,
  FactCell,
  EntityHero,
  FactSentence,
  SectionNav,
  DataTable,
} from "@jsonbored/ui-kit";
import { AsyncPanel } from "@/components/metagraphed/primitives";
import { WatchStarButton } from "@/components/metagraphed/watch-star-button";
import { ValidatorHistoryChart } from "@/components/metagraphed/validator-history-chart";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { WatchValidatorAlert } from "@/components/metagraphed/watch-validator-alert";
import { StakeUnstakeModal } from "@/components/metagraphed/stake-unstake-modal";
import { TakeManagementModal } from "@/components/metagraphed/take-management-modal";
import { RouterLink } from "@/components/metagraphed/router-link";
import {
  ValidatorNominatorsTable,
  type ValidatorNominatorsSearch,
} from "@/components/metagraphed/validator-nominators-table";
import { taoCompact, scoreStr } from "@/components/metagraphed/neuron-format";
import {
  nametagIndexQuery,
  validatorDetailQuery,
  validatorHistoryQuery,
  validatorNominatorsQuery,
  metagraphedQueryKey,
} from "@/lib/metagraphed/queries";
import { isValidSs58, ss58PathSegment } from "@/lib/metagraphed/accounts";
import { resolveAddress } from "@/lib/metagraphed/resolve-address";
import { formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";
import { matchesQuery } from "@/lib/metagraphed/url-state";
import { hasValidatorIdentity } from "@/lib/metagraphed/validator-identity";
import { isUnrecognizedValidator } from "@/lib/metagraphed/validator-recognition";
import {
  annualizedDelegatorApyPct,
  apyFromRewardsPer1000,
  formatApyPct,
  formatTakePct,
  type ValidatorApyWindow,
} from "@/lib/metagraphed/validator-apy";
import type { ValidatorDetailSubnet } from "@/lib/metagraphed/types";

// #8251: tabs replace the old single 11,000px+ stacked page — same section nav
// convention as subnets.$netuid.tsx.
const TABS = [
  { id: "subnets", label: "Per-subnet performance" },
  { id: "nominators", label: "Nominators" },
  { id: "history", label: "History" },
] as const;

// Per-subnet table shows the top N by stake until expanded — most validators
// with 100+ memberships have a long tail of dust rows.

export function ValidatorDetailPage() {
  const { hotkey } = useParams({ from: "/validators/$hotkey" });
  return (
    <AppShell>
      <AsyncPanel
        context="validator"
        fallback={<Skeleton className="h-96 w-full" />}
        retryQueryKeys={[validatorDetailQuery(hotkey).queryKey]}
      >
        <ValidatorDetail hotkey={hotkey} />
      </AsyncPanel>
    </AppShell>
  );
}

/** A per-subnet row's own stake/emission, in the token it is denominated in:
 * TAO on root, that subnet's alpha everywhere else (metagraphed#10514). The
 * card's `total_stake_tao` is the priced TAO figure; these are not. */
function subnetStakeStr(s: ValidatorDetailSubnet): string {
  return `${taoCompact(s.stake_alpha)} ${s.netuid === 0 ? "τ" : "α"}`;
}

function subnetEmissionStr(s: ValidatorDetailSubnet): string {
  return `${taoCompact(s.emission_alpha)} ${s.netuid === 0 ? "τ" : "α"}`;
}

function SubnetPerformanceTab({ subnets }: { subnets: ValidatorDetailSubnet[] }) {
  const [q, setQ] = useState("");
  const sorted = useMemo(
    () => [...subnets].sort((a, b) => (b.stake_alpha ?? 0) - (a.stake_alpha ?? 0)),
    [subnets],
  );
  const filtered = useMemo(
    () => sorted.filter((s) => matchesQuery([s.netuid, `SN${s.netuid}`, s.uid], q)),
    [sorted, q],
  );

  if (subnets.length === 0) {
    return (
      <EmptyState
        title="No active subnet memberships"
        description="This hotkey isn't currently registered as a validator on any subnet."
      />
    );
  }

  return (
    <DataTable
      rows={filtered}
      rowKey={(row) => String(row.netuid)}
      caption="Subnet memberships"
      total={filtered.length}
      link={RouterLink}
      search={{ value: q, onChange: setQ, placeholder: "Filter by netuid" }}
      storageKey="validator-subnets"
      columns={[
        {
          key: "netuid",
          label: "Subnet",
          sortable: true,
          value: (row) => row.netuid,
          format: (value) => `SN${String(value)}`,
          render: (row) => <SubnetCellLink s={row} />,
        },
        { key: "uid", label: "UID", kind: "number", sortable: true, value: (row) => row.uid },
        {
          key: "stake",
          label: "Stake",
          kind: "number",
          sortable: true,
          value: (row) => row.stake_alpha ?? null,
          format: (_value, row) => subnetStakeStr(row),
        },
        {
          key: "emission",
          label: "Emission",
          kind: "number",
          sortable: true,
          value: (row) => row.emission_alpha ?? null,
          format: (_value, row) => subnetEmissionStr(row),
        },
        {
          key: "dividends",
          label: "Dividends",
          kind: "number",
          sortable: true,
          value: (row) => row.dividends ?? null,
          format: (value) => scoreStr(typeof value === "number" ? value : undefined),
        },
        {
          key: "trust",
          label: "Val trust",
          kind: "number",
          sortable: true,
          value: (row) => row.validator_trust ?? null,
          format: (value) => scoreStr(typeof value === "number" ? value : undefined),
        },
        {
          key: "permit",
          label: "Permit",
          demote: true,
          value: (row) => (row.validator_permit ? "Yes" : null),
        },
      ]}
    />
  );
}

function SubnetCellLink({ s }: { s: ValidatorDetailSubnet }) {
  return (
    <Link
      to="/subnets/$netuid"
      params={{ netuid: s.netuid }}
      className="text-ink-strong hover:text-accent hover:underline"
    >
      SN{s.netuid}
    </Link>
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
  const search = useSearch({ from: "/validators/$hotkey" });
  const navigate = useNavigate({ from: "/validators/$hotkey" });

  const setSearch = (patch: Partial<ValidatorNominatorsSearch>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
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

// NOT a route enum (#10994): ValidatorApyWindow is the UI-computed APY basis
// (7d/30d/90d plus "snapshot"), and this selector offers the trailing three.
// The value overlap with route windows is coincidence, not lineage.
const APY_WINDOWS: ValidatorApyWindow[] = ["7d", "30d", "90d"];

// #8251: ONE APY tile with a 7d/30d/90d window toggle, replacing the three
// side-by-side cards that showed the same figure three times. Windowed values
// come from daily history (same source/order-sensitivity as the old
// ValidatorApyPanel: points are newest-first, latest finite value wins);
// falls back to the latest-snapshot estimate — labeled as such — while
// history is loading or absent.
function ApyKpiTile({
  hotkey,
  take,
  snapshotApy,
}: {
  hotkey: string;
  take: number | null;
  snapshotApy: number | null;
}) {
  const window: ValidatorApyWindow = "30d";
  const results = useQueries({
    queries: APY_WINDOWS.map((w) => ({
      ...validatorHistoryQuery(hotkey, w),
      staleTime: 60_000,
    })),
  });
  const idx = APY_WINDOWS.indexOf(window);
  const points = results[idx]?.data?.data?.points ?? [];
  let rewards: number | null = null;
  for (const p of points) {
    const v = p.rewards_per_1000_tao;
    if (v != null && Number.isFinite(v)) {
      rewards = v;
      break;
    }
  }
  const windowedApy = apyFromRewardsPer1000(rewards, take);
  const value = windowedApy ?? snapshotApy;
  const usingSnapshot = windowedApy == null;
  return (
    <FactCell
      label="Est. APY"
      value={formatApyPct(value)}
      hint={usingSnapshot ? "latest snapshot · net of take" : `${window} history · net of take`}
      className="rounded border-border/80 p-4"
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
  // #8372: same resolution ladder as the account page's masthead title.
  // displayName feeds string-only props (validatorName, watch label) as well
  // as the JSX page title, so it stays a plain string via resolveAddress
  // rather than the JSX AddressDisplay component.
  const { data: nametags } = useQuery(nametagIndexQuery());
  const resolvedTitle = resolveAddress(hotkey, {
    identityName: hasIdentity ? identity?.name : undefined,
    nametag: nametags?.get(hotkey) ?? null,
    keep: 8,
  });
  const displayName = resolvedTitle.display;
  const snapshotApy = annualizedDelegatorApyPct(
    detail.total_emission_tao,
    detail.total_stake_tao,
    detail.take,
  );
  // Take is network-wide, not subnet-scoped, so unlike the per-subnet Stake
  // action this belongs at the page level. Hidden entirely (not just
  // internally blocked) until the connected wallet is confirmed to be this
  // validator's owning coldkey -- #5246's own requirement.
  const { wallet } = useWallet();
  const isOwner = !!wallet && !!detail.coldkey && wallet.address === detail.coldkey;
  // #8251: the ONE Stake/Delegate CTA — defaults to the validator's largest-
  // stake subnet (StakeUnstakeModal is (hotkey, netuid)-scoped, and the
  // biggest membership is the natural place a delegator starts).
  const topSubnet = useMemo(
    () =>
      [...detail.subnets].sort((a, b) => (b.stake_alpha ?? 0) - (a.stake_alpha ?? 0))[0] ?? null,
    [detail.subnets],
  );

  return (
    <>
      <EntityHero
        name={displayName}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {topSubnet ? (
              <StakeUnstakeModal
                hotkey={hotkey}
                netuid={topSubnet.netuid}
                validatorName={hasIdentity ? displayName : undefined}
                trigger={(open) => (
                  <button
                    type="button"
                    onClick={open}
                    className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-accent-surface px-3.5 py-2 text-13 font-medium text-accent-text transition-colors hover:border-accent/70"
                  >
                    <Coins className="size-3.5" aria-hidden />
                    Delegate
                  </button>
                )}
              />
            ) : null}
            <div className="mg-actions">
              {isOwner ? (
                <TakeManagementModal
                  hotkey={hotkey}
                  ownerColdkey={detail.coldkey}
                  validatorName={hasIdentity ? displayName : undefined}
                  trigger={(open) => (
                    <button
                      type="button"
                      onClick={open}
                      className="inline-flex items-center gap-1.5 rounded px-2 py-1 min-h-8 text-13 font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Percent className="size-3" aria-hidden />
                      Manage take
                    </button>
                  )}
                />
              ) : null}
              <WatchStarButton
                kind="validator"
                id={hotkey}
                label={hasIdentity ? displayName : "this validator"}
                iconOnly
              />
            </div>
            {isStaleFreshness(generatedAt) ? (
              <StaleBanner
                compact
                generatedAt={generatedAt}
                refreshQueryKeys={[validatorDetailQuery(hotkey).queryKey]}
              />
            ) : null}
          </div>
        }
        sentence={
          <FactSentence>
            {
              <span className="block space-y-4">
                <span className="block max-w-2xl text-13 text-ink-muted">
                  Cross-subnet performance, nominators, and staking history for one Bittensor
                  validator hotkey.
                </span>
                {resolvedTitle.source === "nametag" && resolvedTitle.category ? (
                  <Chip tone="muted" title={`Curated nametag · ${resolvedTitle.category}`}>
                    {resolvedTitle.category}
                  </Chip>
                ) : null}
                {/* Hotkey + coldkey (#6427) get identical, symmetric AddressDisplay
                rows -- the operator name is already the page title, so it
                isn't repeated here. */}
                <dl className="max-w-2xl divide-y divide-border/80 rounded border border-border/80 bg-card">
                  <FieldRow label="Hotkey">
                    <span className="flex w-full min-w-0 items-center">
                      <AddressDisplay
                        ss58={hotkey}
                        truncate={false}
                        valueClassName="truncate min-w-0"
                        fallback={<>—</>}
                        editable
                      />
                    </span>
                  </FieldRow>
                  <FieldRow label="Coldkey">
                    <span className="flex w-full min-w-0 items-center">
                      <AddressDisplay
                        ss58={detail.coldkey}
                        truncate={false}
                        valueClassName="truncate min-w-0"
                        fallback={<span className="text-ink-muted">Not reported</span>}
                        editable
                      />
                    </span>
                  </FieldRow>
                </dl>
              </span>
            }
          </FactSentence>
        }
      />

      {/* #6430: the endpoint is schema-stable, so a mistyped or never-registered
          hotkey resolves to a zeroed aggregate and renders a page of zeros that
          looks exactly like a real validator holding nothing. Say so up front. */}
      {isUnrecognizedValidator(detail) ? (
        <div
          role="status"
          className="mb-8 flex items-start gap-3 rounded border border-health-warn/40 bg-health-warn/5 px-4 py-3"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-health-warn" aria-hidden />
          <div className="min-w-0">
            <p className="text-13 font-medium text-ink-strong">
              This hotkey isn&apos;t a registered validator
            </p>
            <p className="mt-1 max-w-2xl text-13 text-ink-muted">
              The address is a valid ss58, but it has never been seen validating on any subnet —
              every figure below reads zero for that reason, not because the validator is idle. It
              may be mistyped, or a coldkey rather than a hotkey.
            </p>
          </div>
        </div>
      ) : null}

      {/* #8251: KPI band of exactly six — Total stake · Est. APY (one tile
          with a 7/30/90 toggle) · Take · Active subnets · Nominators · Avg
          val-trust. Total emission and Max trust left the band (emission is a
          per-subnet story now told in the performance tab; max-trust
          duplicated avg-trust's signal); the old separate three-card APY
          section is gone — this tile IS the one APY block on the page.
          Mobile is the required 2×3 grid. */}
      <div className="mb-12 grid grid-cols-2 gap-4 xl:grid-cols-3 2xl:grid-cols-6">
        <FactCell
          label="Total stake"
          value={taoCompact(detail.total_stake_tao)}
          hint={`Root ${taoCompact(detail.root_stake_tao)} · Alpha ${taoCompact(detail.alpha_stake_tao)}`}
          className="rounded border-accent/25 p-4"
        />
        <ApyKpiTile hotkey={hotkey} take={detail.take} snapshotApy={snapshotApy} />
        <FactCell
          label="Take rate"
          value={formatTakePct(detail.take)}
          hint="commission kept from delegators"
          className="rounded border-border/80 p-4"
        />
        <FactCell
          label="Active subnets"
          value={formatNumber(detail.subnet_count)}
          hint="validator memberships"
          className="rounded border-border/80 p-4"
        />
        <FactCell
          label="Nominators"
          value={detail.nominator_count != null ? formatNumber(detail.nominator_count) : "—"}
          hint="distinct coldkeys delegated"
          className="rounded border-border/80 p-4"
        />
        <FactCell
          label="Avg validator trust"
          value={scoreStr(detail.avg_validator_trust)}
          hint="mean across subnets"
          className="rounded border-border/80 p-4"
        />
      </div>

      <SectionNav items={TABS.map((t) => ({ id: t.id, name: t.label }))} />

      <div className="mt-6 min-w-0 space-y-8">
        <div id="subnets" data-tab="subnets">
          <AnalyticsSection id="subnets" name="Per-subnet performance">
            <SubnetPerformanceTab subnets={detail.subnets} />
          </AnalyticsSection>
        </div>
        <div id="nominators" data-tab="nominators">
          <AnalyticsSection
            id="nominators"
            name="Nominators"
            question="Derived from stake-delegation events"
          >
            <AsyncPanel
              context="nominators"
              fallback={<Skeleton className="h-64 w-full" />}
              retryQueryKeys={[metagraphedQueryKey("validator-nominators", hotkey)]}
            >
              <NominatorsSection hotkey={hotkey} />
            </AsyncPanel>
          </AnalyticsSection>
        </div>
        <div id="history" data-tab="history">
          <AnalyticsSection
            id="history"
            name="Stake & rewards over time"
            question="Daily snapshots"
          >
            <ValidatorHistoryChart hotkey={hotkey} />
          </AnalyticsSection>
        </div>
      </div>

      <div className="mt-8">
        <AnalyticsSection
          id="watch"
          name="Watch this validator"
          question="Alert on new delegations or stake, via the existing chain alert-triggers API."
        >
          <WatchValidatorAlert hotkey={hotkey} />
        </AnalyticsSection>
      </div>

      {/* #6432: same placement blocks.$ref.tsx and extrinsics.$hash.tsx use. */}
      <div className="mt-6">
        <Link
          to="/validators"
          className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-13 font-medium hover:border-ink/30"
        >
          ← All validators
        </Link>
      </div>

      <AnalyticsSection
        id="call"
        name="Call this endpoint"
        question="Copy a ready-to-run request for this validator."
      >
        <EndpointSnippet
          rows={[
            { label: "summary", path: `/api/v1/validators/${sourceRef}` },
            { label: "nominators", path: `/api/v1/validators/${sourceRef}/nominators` },
            { label: "history", path: `/api/v1/validators/${sourceRef}/history` },
          ]}
        />
      </AnalyticsSection>

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

// Mirrors blocks.$ref.tsx / extrinsics.$hash.tsx's own FieldRow (#6424) --
// same label/value dl row idiom, copied rather than shared per this
// codebase's per-route convention for small local helpers.
function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <dt className="text-13 text-ink-muted sm:w-20 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 w-full sm:flex-1">{children}</dd>
    </div>
  );
}
