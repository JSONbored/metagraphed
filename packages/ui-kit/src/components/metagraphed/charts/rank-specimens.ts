import type { CompositionSegment } from "./composition-breakdown";
import type { LeaderCardItem } from "./leader-cards";
import type { MarkerRailItem } from "./marker-rail";
import type { RankedRailItem } from "./ranked-rails";

/** Deterministic specimens for /design/primitives and the e2e project. */
export const RAIL_SPECIMEN: RankedRailItem[] = [
  ["Targon", 1_890_000, 412_000],
  ["Chutes", 1_210_000, 380_000],
  ["Affine", 640_000, 120_000],
  ["Score", 512_000, 98_000],
  ["Nineteen", 330_000, 61_000],
  ["Bitmind", 280_000, 44_000],
  ["Gradients", 190_000, 39_000],
  ["Apex", 140_000, 30_000],
  ["Macrocosmos", 120_000, 22_000],
  ["Omron", 95_000, 18_000],
  ["Vidaio", 61_000, 9_000],
  ["Dippy", 42_000, 6_000],
].map(([label, value, secondary]) => ({
  key: String(label),
  label: String(label),
  value: Number(value),
  secondary: Number(secondary),
  detail: [
    { key: "take", label: "Take", value: "9%" },
    { key: "apy", label: "APY", value: "0.46%" },
    { key: "nominators", label: "Nominators", value: "1,204" },
  ],
}));

export const MARKER_SPECIMEN: MarkerRailItem[] = [
  ["OpenAPI", "openapi", 99.8],
  ["Validator API", "subnet-api", 97.2],
  ["Docs", "docs", 100],
  ["Dashboard", "dashboard", 91.4],
  ["SSE feed", "sse", null],
].map(([label, tag, value]) => ({
  key: String(label),
  label: String(label),
  tag: String(tag),
  value: value as number | null,
}));

/** Shares the rails' keys on purpose: the specimen page cross-highlights. */
export const COMPOSITION_SPECIMEN: CompositionSegment[] = [
  ["Targon", 41],
  ["Chutes", 41],
  ["Affine", 18],
].map(([label, value]) => ({
  key: String(label),
  label: String(label),
  value: Number(value),
}));

export const LEADER_SPECIMEN: LeaderCardItem[] = RAIL_SPECIMEN.map((r, i) => ({
  key: r.key,
  name: r.label,
  sub: i % 2 ? "Macrocosmos" : "Rayon Labs",
  value: `${(r.value / 1_000_000).toFixed(2)}Mτ`,
  delta: i === 3 ? "new" : ((i * 7) % 11) / 10 - 0.3,
  href: `/subnets/${i + 1}`,
}));
