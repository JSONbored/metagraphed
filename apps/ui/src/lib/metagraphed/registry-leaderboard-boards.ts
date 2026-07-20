import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import type { LeaderboardBoardKey, LeaderboardRow } from "@/lib/metagraphed/types";

/** Economic opportunity boards (miners / validators) — prominent on /leaderboards (#6995). */
export const ECONOMIC_BOARD_KEYS = [
  "open-slots",
  "cheapest-registration",
  "highest-emission",
  "validator-headroom",
] as const satisfies readonly LeaderboardBoardKey[];

/** Operational / registry-profile boards. */
export const OPERATIONAL_BOARD_KEYS = [
  "healthiest",
  "fastest-rpc",
  "most-complete",
  "most-enriched",
  "fastest-growing",
  "most-reliable",
] as const satisfies readonly LeaderboardBoardKey[];

export type RegistryBoardColumn = {
  key: string;
  label: string;
  align?: "left" | "right";
  format: (row: LeaderboardRow) => string;
};

export type RegistryBoardSpec = {
  key: LeaderboardBoardKey;
  label: string;
  description: string;
  /** Compact homepage / card metric. */
  primaryMetric: (row: LeaderboardRow) => string | null;
  columns: RegistryBoardColumn[];
};

function pct01(v: number | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

function ms(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v)} ms`;
}

export const REGISTRY_BOARD_SPECS: Record<LeaderboardBoardKey, RegistryBoardSpec> = {
  healthiest: {
    key: "healthiest",
    label: "Healthiest",
    description: "Subnets ranked by live surface uptime, then average latency.",
    primaryMetric: (r) =>
      r.uptime_ratio != null ? `${Math.round(r.uptime_ratio * 100)}% up` : null,
    columns: [
      {
        key: "uptime",
        label: "Uptime",
        align: "right",
        format: (r) => pct01(r.uptime_ratio, 0),
      },
      {
        key: "surfaces",
        label: "Surfaces OK",
        align: "right",
        format: (r) =>
          r.surfaces_ok != null && r.surfaces_total != null
            ? `${formatNumber(r.surfaces_ok)}/${formatNumber(r.surfaces_total)}`
            : "—",
      },
      {
        key: "latency",
        label: "Avg latency",
        align: "right",
        format: (r) => ms(r.avg_latency_ms),
      },
    ],
  },
  "fastest-rpc": {
    key: "fastest-rpc",
    label: "Fastest RPC",
    description: "Subnets with the lowest observed RPC probe latency.",
    primaryMetric: (r) => (r.latency_ms != null ? `${Math.round(r.latency_ms)}ms` : null),
    columns: [
      {
        key: "latency",
        label: "Latency",
        align: "right",
        format: (r) => ms(r.latency_ms),
      },
    ],
  },
  "most-complete": {
    key: "most-complete",
    label: "Most complete",
    description: "Subnets ranked by registry profile completeness score.",
    primaryMetric: (r) =>
      r.completeness_score != null ? `${Math.round(r.completeness_score)}%` : null,
    columns: [
      {
        key: "completeness",
        label: "Completeness",
        align: "right",
        format: (r) =>
          r.completeness_score != null ? `${Math.round(r.completeness_score)}%` : "—",
      },
    ],
  },
  "most-enriched": {
    key: "most-enriched",
    label: "Most enriched",
    description: "Subnets ranked by curated surface count, then operational interfaces.",
    primaryMetric: (r) =>
      r.surface_count != null
        ? `${r.surface_count} surface${r.surface_count === 1 ? "" : "s"}`
        : null,
    columns: [
      {
        key: "surfaces",
        label: "Surfaces",
        align: "right",
        format: (r) => (r.surface_count != null ? formatNumber(r.surface_count) : "—"),
      },
      {
        key: "operational",
        label: "Operational",
        align: "right",
        format: (r) =>
          r.operational_interface_count != null ? formatNumber(r.operational_interface_count) : "—",
      },
    ],
  },
  "fastest-growing": {
    key: "fastest-growing",
    label: "Fastest growing",
    description: "Subnets with the largest recent completeness gains.",
    primaryMetric: (r) =>
      r.completeness_delta != null ? `+${Math.round(r.completeness_delta)} pts` : null,
    columns: [
      {
        key: "delta",
        label: "Δ Completeness",
        align: "right",
        format: (r) =>
          r.completeness_delta != null ? `+${Math.round(r.completeness_delta)}` : "—",
      },
    ],
  },
  "most-reliable": {
    key: "most-reliable",
    label: "Most reliable",
    description: "Windowed reliability score (uptime minus latency penalty), graded A–F.",
    primaryMetric: (r) =>
      r.score != null ? `${Math.round(r.score)}${r.grade ? ` (${r.grade})` : ""}` : null,
    columns: [
      {
        key: "score",
        label: "Score",
        align: "right",
        format: (r) => (r.score != null ? formatNumber(r.score) : "—"),
      },
      {
        key: "grade",
        label: "Grade",
        align: "right",
        format: (r) => r.grade ?? "—",
      },
      {
        key: "uptime",
        label: "Uptime",
        align: "right",
        format: (r) => pct01(r.uptime_ratio, 0),
      },
      {
        key: "latency",
        label: "Avg latency",
        align: "right",
        format: (r) => ms(r.avg_latency_ms),
      },
    ],
  },
  "open-slots": {
    key: "open-slots",
    label: "Open slots",
    description: "Where there is still room to register a neuron — most open UIDs first.",
    primaryMetric: (r) => (r.open_slots != null ? `${formatNumber(r.open_slots)} open` : null),
    columns: [
      {
        key: "open",
        label: "Open slots",
        align: "right",
        format: (r) => (r.open_slots != null ? formatNumber(r.open_slots) : "—"),
      },
      {
        key: "max",
        label: "Max UIDs",
        align: "right",
        format: (r) => (r.max_uids != null ? formatNumber(r.max_uids) : "—"),
      },
      {
        key: "cost",
        label: "Reg. cost",
        align: "right",
        format: (r) => formatTao(r.registration_cost_tao),
      },
    ],
  },
  "cheapest-registration": {
    key: "cheapest-registration",
    label: "Cheapest registration",
    description: "Open subnets ranked by lowest registration cost in TAO.",
    primaryMetric: (r) =>
      r.registration_cost_tao != null ? formatTao(r.registration_cost_tao) : null,
    columns: [
      {
        key: "cost",
        label: "Reg. cost",
        align: "right",
        format: (r) => formatTao(r.registration_cost_tao),
      },
      {
        key: "open",
        label: "Open slots",
        align: "right",
        format: (r) => (r.open_slots != null ? formatNumber(r.open_slots) : "—"),
      },
    ],
  },
  "highest-emission": {
    key: "highest-emission",
    label: "Highest emission",
    description: "Subnets ranked by share of network emissions.",
    primaryMetric: (r) => (r.emission_share != null ? pct01(r.emission_share, 2) : null),
    columns: [
      {
        key: "emission",
        label: "Emission share",
        align: "right",
        format: (r) => pct01(r.emission_share, 2),
      },
      {
        key: "stake",
        label: "Total stake",
        align: "right",
        format: (r) => formatTao(r.total_stake_tao),
      },
      {
        key: "validators",
        label: "Validators",
        align: "right",
        format: (r) => (r.validator_count != null ? formatNumber(r.validator_count) : "—"),
      },
      {
        key: "miners",
        label: "Miners",
        align: "right",
        format: (r) => (r.miner_count != null ? formatNumber(r.miner_count) : "—"),
      },
    ],
  },
  "validator-headroom": {
    key: "validator-headroom",
    label: "Validator headroom",
    description: "Subnets with open validator permits, ranked by remaining headroom.",
    primaryMetric: (r) =>
      r.validator_headroom != null ? `${formatNumber(r.validator_headroom)} open` : null,
    columns: [
      {
        key: "headroom",
        label: "Headroom",
        align: "right",
        format: (r) => (r.validator_headroom != null ? formatNumber(r.validator_headroom) : "—"),
      },
      {
        key: "validators",
        label: "Validators",
        align: "right",
        format: (r) =>
          r.validator_count != null && r.max_validators != null
            ? `${formatNumber(r.validator_count)}/${formatNumber(r.max_validators)}`
            : r.validator_count != null
              ? formatNumber(r.validator_count)
              : "—",
      },
      {
        key: "emission",
        label: "Emission share",
        align: "right",
        format: (r) => pct01(r.emission_share, 2),
      },
    ],
  },
};
