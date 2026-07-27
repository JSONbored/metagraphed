import { useSuspenseQuery } from "@tanstack/react-query";
import {
  DefinitionList,
  FreshnessPill,
  Panel,
  SectionLabel,
  type DefinitionItem,
} from "@/components/metagraphed/primitives";
import { networkParametersQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import type { NetworkParameters } from "@/lib/metagraphed/types";

type ParameterKind = "percent" | "tao" | "count" | "raw";

interface ParameterMeta {
  label: string;
  hint: string;
  kind: ParameterKind;
}

// Display names + kind for every field networkParametersQuery (#6997)
// currently surfaces off /api/v1/network/parameters. A key outside this map
// still renders -- grouped under "Other" below, key shown in mono -- rather
// than being dropped, so this panel doesn't need its own PR the moment the
// query layer starts passing through a new field. True forward-compatibility
// is bounded by networkParametersQuery's own hand-picked field list (see the
// PR description).
const PARAMETER_META: Record<string, ParameterMeta> = {
  stake_threshold_tao: {
    label: "Stake threshold",
    hint: "Minimum stake required to register a hotkey",
    kind: "tao",
  },
  tao_weight: {
    label: "TAO weight",
    hint: "Root-network weight ratio applied in Yuma consensus",
    kind: "percent",
  },
  pending_childkey_cooldown_blocks: {
    label: "Childkey cooldown",
    hint: "Blocks before a pending child hotkey activates",
    kind: "count",
  },
};

// Issuance/supply, emission, timing/tempo per the issue's requested
// grouping. No "fees" group: the endpoint returns nothing fee-related today
// (noted as out of scope in the PR description, per the issue's own carve-out).
const PARAMETER_GROUPS: ReadonlyArray<{ label: string; keys: readonly string[] }> = [
  { label: "Issuance & supply", keys: ["stake_threshold_tao"] },
  { label: "Emission", keys: ["tao_weight"] },
  { label: "Timing & tempo", keys: ["pending_childkey_cooldown_blocks"] },
];

interface ParameterRow {
  key: string;
  label: string;
  hint?: string;
  kind: ParameterKind;
  value: unknown;
}

export interface ParameterGroup {
  label: string;
  rows: ParameterRow[];
}

export function buildParameterGroups(parameters: NetworkParameters): ParameterGroup[] {
  const raw = parameters as unknown as Record<string, unknown>;
  const consumed = new Set<string>(["queried_at"]);
  const groups: ParameterGroup[] = PARAMETER_GROUPS.map((group) => ({
    label: group.label,
    rows: group.keys.map((key): ParameterRow => {
      consumed.add(key);
      const meta = PARAMETER_META[key];
      return {
        key,
        label: meta.label,
        hint: meta.hint,
        kind: meta.kind,
        value: raw[key] ?? null,
      };
    }),
  }));

  const leftoverKeys = Object.keys(raw).filter((key) => !consumed.has(key));
  if (leftoverKeys.length > 0) {
    groups.push({
      label: "Other",
      rows: leftoverKeys.map((key) => ({
        key,
        label: key,
        kind: "raw" as const,
        value: raw[key] ?? null,
      })),
    });
  }
  return groups;
}

export function formatParameterValue(row: ParameterRow): { text: string; title?: string } {
  switch (row.kind) {
    case "percent":
      // Matches emission-yield-panel.tsx's fmtPct convention for the same
      // 0..1 governance-ratio shape -- no shared percent formatter exists in
      // apps/ui/src/lib today (every consumer inlines its own, 1-4 decimals
      // depending on context; see the PR description).
      return typeof row.value === "number"
        ? { text: `${(row.value * 100).toFixed(4)}%` }
        : { text: "—" };
    case "tao": {
      const n = typeof row.value === "number" ? row.value : null;
      return { text: formatTao(n), title: n != null ? `${n} τ` : undefined };
    }
    case "count":
      return { text: formatNumber(typeof row.value === "number" ? row.value : null) };
    default:
      return { text: row.value == null ? "—" : String(row.value) };
  }
}

function toDefinitionItems(rows: ParameterRow[]): DefinitionItem[] {
  return rows.map((row) => {
    const { text, title } = formatParameterValue(row);
    return {
      term: row.hint ? row.label : <span className="font-mono">{row.label}</span>,
      detail: <span title={title}>{text}</span>,
      title: row.hint,
    };
  });
}

export function NetworkParametersPanel() {
  const { data: res } = useSuspenseQuery(networkParametersQuery());
  const groups = buildParameterGroups(res.data);
  return (
    <Panel
      title="Parameters"
      action={<FreshnessPill updatedAt={res.data.queried_at} />}
      className="mb-6"
    >
      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group.label}>
            <SectionLabel>{group.label}</SectionLabel>
            <DefinitionList
              layout="inline"
              className="mt-2"
              items={toDefinitionItems(group.rows)}
            />
          </div>
        ))}
      </div>
    </Panel>
  );
}
