import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  CompareLedger,
  EntityHero,
  FactSentence,
  RangeControl,
  type CompareEntity,
  type CompareGroup,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { EmptyState, ErrorState } from "@/components/metagraphed/states";
import { compareQuery, compareValidatorsQuery } from "@/lib/metagraphed/queries";
import { formatDecimal, formatNumber, formatPct, formatTao } from "@/lib/metagraphed/format";
import { resolveAddress, truncateSs58 } from "@/lib/metagraphed/resolve-address";
import { Route, parseHotkeys, parseNetuids } from "./compare";
import type { CompareSubnet, CompareValidator } from "@/lib/metagraphed/types";

/** Uptime as a 0–100 percentage from the compare payload's own probe counts. */
function uptimePct(health: CompareSubnet["health"]): number | null {
  const total = health?.surface_count;
  const ok = health?.ok_count;
  if (!total || ok == null) return null;
  return (ok / total) * 100;
}

const pct = (value: number | string) =>
  typeof value === "number" ? `${formatDecimal(value, 2)}%` : String(value);
const share = (value: number | string) =>
  typeof value === "number" ? `${formatPct(value, 3)}` : String(value);
const count = (value: number | string) =>
  typeof value === "number" ? formatNumber(value) : String(value);
const tao = (value: number | string) =>
  typeof value === "number" ? formatTao(value) : String(value);

const API_PATHS = ["/api/v1/compare", "/api/v1/compare/validators"];

/** Registers the page's sources from INSIDE `AppShell`, which owns the provider. */
function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

export function ComparePage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const subnets = useMemo(() => parseNetuids(search.subnets), [search.subnets]);
  const validators = useMemo(() => parseHotkeys(search.validators), [search.validators]);
  const kind =
    search.kind || (validators.length > 0 && subnets.length === 0 ? "validators" : "subnets");

  return (
    <AppShell>
      <ApiSources />
      <EntityHero
        className="mg-hero--compare"
        name="Compare"
        sentence={
          <FactSentence>
            {kind === "validators"
              ? validators.length < 2
                ? validators.length === 1
                  ? "One validator selected. Add one more to compare."
                  : "Pick two validators to compare."
                : `${validators.length} selected validators, side by side.`
              : subnets.length < 2
                ? subnets.length === 1
                  ? `SN${subnets[0]} selected. Add one more to compare.`
                  : "Pick two subnets to compare."
                : `${subnets.map((netuid) => `SN${netuid}`).join(" · ")}, side by side.`}
          </FactSentence>
        }
        secondary={
          <RangeControl
            label="What to compare"
            options={[
              { value: "subnets", label: "Subnets" },
              { value: "validators", label: "Validators" },
            ]}
            value={kind}
            onChange={(next) =>
              navigate({
                to: "/compare",
                search:
                  next === "subnets"
                    ? { kind: next, subnets: search.subnets, validators: "" }
                    : { kind: next, subnets: "", validators: search.validators },
              })
            }
          />
        }
      />
      {kind === "validators" ? (
        <ValidatorLedger hotkeys={validators} />
      ) : (
        <SubnetLedger netuids={subnets} />
      )}
    </AppShell>
  );
}

function SubnetLedger({ netuids }: { netuids: number[] }) {
  const enabled = netuids.length >= 2;
  const { data, isPending, isError, error, refetch } = useQuery({
    ...compareQuery(netuids),
    enabled,
    retry: 0,
  });
  const rows = useMemo(() => data?.data?.subnets ?? [], [data?.data?.subnets]);
  const bySubnet = useMemo(() => {
    const map = new Map<number, CompareSubnet>();
    for (const s of rows) map.set(s.netuid, s);
    return map;
  }, [rows]);

  const entities: CompareEntity[] = netuids.map((netuid) => ({
    key: String(netuid),
    name: bySubnet.get(netuid)?.name ?? `Subnet ${netuid}`,
    sub: `SN${netuid}`,
    href: `/subnets/${netuid}`,
  }));
  const at = <T,>(pick: (s: CompareSubnet | undefined) => T) =>
    netuids.map((netuid) => pick(bySubnet.get(netuid)));

  const groups: CompareGroup[] = [
    {
      label: "Economics",
      rows: [
        {
          key: "emission",
          label: "Emission share",
          values: at((s) => s?.economics?.emission_share ?? null),
          better: "high",
          format: share,
        },
        {
          key: "price",
          label: "Alpha price",
          values: at((s) => s?.economics?.alpha_price_tao ?? null),
          format: (v) => (typeof v === "number" ? `${formatDecimal(v, 4)}τ` : String(v)),
        },
        {
          key: "stake",
          label: "Total stake",
          values: at((s) => s?.economics?.total_stake_alpha ?? null),
          better: "high",
          format: tao,
        },
        {
          key: "registration",
          label: "Registration cost",
          values: at((s) => s?.economics?.registration_cost_tao ?? null),
          better: "low",
          format: tao,
        },
        {
          key: "slots",
          label: "Open slots",
          values: at((s) => s?.economics?.open_slots ?? null),
          better: "high",
          format: count,
        },
      ],
    },
    {
      label: "Participation",
      rows: [
        {
          key: "validators",
          label: "Validators",
          values: at((s) => s?.economics?.validator_count ?? null),
          better: "high",
          format: count,
        },
        {
          key: "miners",
          label: "Miners",
          values: at((s) => s?.economics?.miner_count ?? null),
          better: "high",
          format: count,
        },
      ],
    },
    {
      label: "Integration",
      rows: [
        {
          key: "surfaces",
          label: "Surfaces",
          values: at((s) => s?.structure?.surface_count ?? null),
          better: "high",
          format: count,
        },
        {
          key: "callable",
          label: "Callable interfaces",
          values: at((s) => s?.structure?.operational_interface_count ?? null),
          better: "high",
          format: count,
        },
        {
          key: "completeness",
          label: "Completeness",
          values: at((s) => s?.structure?.completeness_score ?? null),
          better: "high",
          format: (v) => (typeof v === "number" ? `${Math.round(v)}/100` : String(v)),
        },
        {
          key: "uptime",
          label: "Uptime",
          values: at((s) => uptimePct(s?.health)),
          better: "high",
          format: pct,
        },
        {
          key: "latency",
          label: "Avg latency",
          values: at((s) => s?.health?.avg_latency_ms ?? null),
          better: "low",
          format: (v) => (typeof v === "number" ? `${Math.round(v)}ms` : String(v)),
        },
      ],
    },
  ];

  return (
    <AnalyticsSection
      className="mg-compare-ledger-section"
      id="ledger"
      name="Side by side"
      question="Every fact these subnets publish, with the better value marked."
      footnote="/api/v1/compare · the winner is only marked where one direction is clearly better."
    >
      {!enabled ? (
        <EmptyState
          title={netuids.length === 1 ? "Add one more subnet" : "Pick two subnets"}
          description={
            netuids.length === 1
              ? "Choose one more subnet from the directory to unlock the comparison."
              : "Choose any two subnets from the directory to see their published facts side by side."
          }
          action={{ label: "Browse subnets", href: "/subnets" }}
        />
      ) : isPending ? (
        <CompareLedger
          entities={entities}
          groups={groups}
          loading
          ariaLabel={`Loading comparison of ${entities.map((e) => e.name).join(", ")}`}
        />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => void refetch()} context="the comparison" />
      ) : (
        <CompareLedger
          entities={entities}
          groups={groups}
          ariaLabel={`Comparison of ${entities.map((e) => e.name).join(", ")}`}
        />
      )}
    </AnalyticsSection>
  );
}

function ValidatorLedger({ hotkeys }: { hotkeys: string[] }) {
  const enabled = hotkeys.length >= 2;
  const { data, isPending, isError, error, refetch } = useQuery({
    ...compareValidatorsQuery(hotkeys),
    enabled,
    retry: 0,
  });
  const rows = useMemo(() => data?.data?.validators ?? [], [data?.data?.validators]);
  const byHotkey = useMemo(() => {
    const map = new Map<string, CompareValidator>();
    for (const v of rows) map.set(v.hotkey, v);
    return map;
  }, [rows]);

  const entities: CompareEntity[] = hotkeys.map((hotkey) => ({
    key: hotkey,
    name: byHotkey.get(hotkey)?.coldkey_identity?.name ?? resolveAddress(hotkey).display,
    sub: truncateSs58(hotkey),
    href: `/validators/${hotkey}`,
  }));
  const at = <T,>(pick: (v: CompareValidator | undefined) => T) =>
    hotkeys.map((hotkey) => pick(byHotkey.get(hotkey)));

  const groups: CompareGroup[] = [
    {
      label: "Return",
      rows: [
        {
          key: "apy",
          label: "Est. APY",
          values: at((v) => v?.apy_estimate ?? null),
          better: "high",
          format: share,
        },
        {
          key: "take",
          label: "Take",
          values: at((v) => v?.take ?? null),
          better: "low",
          format: share,
        },
      ],
    },
    {
      label: "Size",
      rows: [
        {
          key: "stake",
          label: "Total stake",
          values: at((v) => v?.total_stake_tao ?? null),
          better: "high",
          format: tao,
        },
        {
          key: "emission",
          label: "Total emission",
          values: at((v) => v?.total_emission_tao ?? null),
          better: "high",
          format: tao,
        },
        {
          key: "nominators",
          label: "Nominators",
          values: at((v) => v?.nominator_count ?? null),
          better: "high",
          format: count,
        },
        {
          key: "subnets",
          label: "Subnets",
          values: at((v) => v?.subnet_count ?? null),
          better: "high",
          format: count,
        },
      ],
    },
    {
      label: "Standing",
      rows: [
        {
          key: "avg-trust",
          label: "Avg validator trust",
          values: at((v) => v?.avg_validator_trust ?? null),
          better: "high",
          format: (v) => (typeof v === "number" ? formatDecimal(v, 3) : String(v)),
        },
        {
          key: "max-trust",
          label: "Max validator trust",
          values: at((v) => v?.max_validator_trust ?? null),
          better: "high",
          format: (v) => (typeof v === "number" ? formatDecimal(v, 3) : String(v)),
        },
      ],
    },
  ];

  return (
    <AnalyticsSection
      className="mg-compare-ledger-section"
      id="ledger"
      name="Side by side"
      question="What each operator takes, holds and is trusted with."
      footnote="/api/v1/compare/validators · the winner is only marked where one direction is clearly better."
    >
      {!enabled ? (
        <EmptyState
          title={hotkeys.length === 1 ? "Add one more validator" : "Pick two validators"}
          description={
            hotkeys.length === 1
              ? "Choose one more validator from the directory to unlock the comparison."
              : "Choose any two validators from the directory to see their published facts side by side."
          }
          action={{ label: "Browse validators", href: "/validators" }}
        />
      ) : isPending ? (
        <CompareLedger
          entities={entities}
          groups={groups}
          loading
          ariaLabel={`Loading comparison of ${entities.map((e) => e.name).join(", ")}`}
        />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => void refetch()} context="the comparison" />
      ) : (
        <CompareLedger
          entities={entities}
          groups={groups}
          ariaLabel={`Comparison of ${entities.map((e) => e.name).join(", ")}`}
        />
      )}
    </AnalyticsSection>
  );
}
