import { useSuspenseQuery } from "@tanstack/react-query";
import { DefinitionList, SectionLabel, type DefinitionItem } from "@jsonbored/ui-kit";
import { Panel, FreshnessPill } from "@/components/metagraphed/primitives";
import { networkParametersQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import type { NetworkParameters } from "@/lib/metagraphed/types";

type ParamKind = "percent" | "tao" | "count" | "raw";

interface ParamMeta {
  label: string;
  hint: string;
  kind: ParamKind;
}

// Display-name + grouping map for the known /api/v1/network/parameters keys
// (#6997). A key absent here still renders -- see buildParameterGroups's
// "Other" fallback -- so a future field lands in mono under its raw name
// instead of being silently dropped (#8380).
const PARAM_META: Record<string, ParamMeta> = {
  stake_threshold_tao: {
    label: "Stake threshold",
    hint: "Minimum stake required to register a hotkey",
    kind: "tao",
  },
  tao_weight: {
    label: "TAO weight",
    hint: "Root-weight ratio in Yuma consensus",
    kind: "percent",
  },
  pending_childkey_cooldown_blocks: {
    label: "Childkey cooldown",
    hint: "Blocks before a pending child key activates",
    kind: "count",
  },
};

const PARAM_GROUPS: readonly { label: string; keys: readonly string[] }[] = [
  { label: "Issuance & supply", keys: ["stake_threshold_tao"] },
  { label: "Emission", keys: ["tao_weight"] },
  { label: "Timing & tempo", keys: ["pending_childkey_cooldown_blocks"] },
];

export interface ParameterRow {
  key: string;
  label: string;
  hint?: string;
  kind: ParamKind;
  value: unknown;
}

export interface ParameterGroup {
  label: string;
  rows: ParameterRow[];
}

/**
 * Groups the flat NetworkParameters response into the sections the response
 * shape implies, per known-key display map -- any key this map doesn't cover
 * (a future addition to the endpoint) falls into a trailing "Other" group
 * instead of being dropped, satisfying #8380's "no UI PR for a new param"
 * requirement without needing a schema/query change to react to one.
 */
export function buildParameterGroups(parameters: NetworkParameters): ParameterGroup[] {
  const raw = parameters as unknown as Record<string, unknown>;
  const consumed = new Set<string>(["queried_at"]);

  const groups: ParameterGroup[] = PARAM_GROUPS.map((group) => ({
    label: group.label,
    rows: group.keys.map((key) => {
      consumed.add(key);
      const meta = PARAM_META[key];
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
        kind: "raw",
        value: raw[key] ?? null,
      })),
    });
  }

  return groups;
}

/** Renders one row's value per its kind, τ amounts carrying full precision in a title. */
export function formatParameterValue(row: ParameterRow): { text: string; title?: string } {
  switch (row.kind) {
    case "percent":
      return typeof row.value === "number"
        ? { text: `${(row.value * 100).toFixed(2)}%` }
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
