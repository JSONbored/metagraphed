import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { leaderboardsQuery } from "@/lib/metagraphed/queries";
import { BrandIcon } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import type { LeaderboardBoardKey, LeaderboardRow } from "@/lib/metagraphed/types";

// #6995: surface the registry's own D1-computed leaderboards on /leaderboards.
// Ten boards, split into economic-opportunity boards (open-slots,
// cheapest-registration, highest-emission, validator-headroom) — the
// "where should I register / validate" boards, placed first per the issue — and
// operational boards (healthiest, fastest-rpc, most-complete, most-enriched,
// fastest-growing, most-reliable). Each board is a config entry mapping its key
// to a label, a one-line blurb, and the formatter for its own metric column
// (each board carries different metric fields — see LeaderboardRow). All boards
// render even when currently empty, so every board stays reachable from the UI.

const ROWS_PER_BOARD = 10;

interface BoardSpec {
  key: LeaderboardBoardKey;
  label: string;
  blurb: string;
  metric: (row: LeaderboardRow) => string | null;
}

const round = (v: number) => Math.round(v);
// TAO amounts span from ~0.0001 (cheap registration) to millions (total stake),
// so cap fraction digits rather than pinning a fixed precision.
const tao = (v: number) =>
  `${v.toLocaleString("en-US", { maximumFractionDigits: v >= 1 ? 2 : 4 })} τ`;

const ECONOMIC_BOARDS: BoardSpec[] = [
  {
    key: "open-slots",
    label: "Open slots",
    blurb: "Most room to register a new neuron.",
    metric: (r) => (r.open_slots != null ? `${r.open_slots.toLocaleString("en-US")} open` : null),
  },
  {
    key: "cheapest-registration",
    label: "Cheapest registration",
    blurb: "Lowest registration cost among subnets currently open.",
    metric: (r) => (r.registration_cost_tao != null ? tao(r.registration_cost_tao) : null),
  },
  {
    key: "highest-emission",
    label: "Highest emission",
    blurb: "Where network emission is concentrated.",
    metric: (r) => (r.emission_share != null ? `${(r.emission_share * 100).toFixed(2)}%` : null),
  },
  {
    key: "validator-headroom",
    label: "Validator headroom",
    blurb: "Open validator permits still attainable.",
    metric: (r) =>
      r.validator_headroom != null
        ? `${r.validator_headroom} permit${r.validator_headroom === 1 ? "" : "s"}`
        : null,
  },
];

const OPERATIONAL_BOARDS: BoardSpec[] = [
  {
    key: "healthiest",
    label: "Healthiest",
    blurb: "Highest live operational-surface uptime.",
    metric: (r) => (r.uptime_ratio != null ? `${round(r.uptime_ratio * 100)}% up` : null),
  },
  {
    key: "fastest-rpc",
    label: "Fastest RPC",
    blurb: "Lowest RPC latency.",
    metric: (r) => (r.latency_ms != null ? `${round(r.latency_ms)}ms` : null),
  },
  {
    key: "most-complete",
    label: "Most complete",
    blurb: "Most complete profiles by completeness score.",
    metric: (r) => (r.completeness_score != null ? `${round(r.completeness_score)}%` : null),
  },
  {
    key: "most-enriched",
    label: "Most enriched",
    blurb: "Most registered surfaces.",
    metric: (r) =>
      r.surface_count != null
        ? `${r.surface_count} surface${r.surface_count === 1 ? "" : "s"}`
        : null,
  },
  {
    key: "fastest-growing",
    label: "Fastest growing",
    blurb: "Biggest recent completeness gain.",
    metric: (r) => (r.completeness_delta != null ? `+${round(r.completeness_delta)} pts` : null),
  },
  {
    key: "most-reliable",
    label: "Most reliable",
    blurb: "Best windowed reliability score (uptime minus latency penalty).",
    metric: (r) => (r.score != null ? `${round(r.score)}${r.grade ? ` · ${r.grade}` : ""}` : null),
  },
];

export function RegistryLeaderboards() {
  const { data: res } = useSuspenseQuery(leaderboardsQuery());
  const boards = res.data;

  return (
    <section id="registry-leaderboards" className="scroll-mt-24 space-y-8">
      <div className="max-w-2xl">
        <div className="mg-type-micro text-ink-muted inline-flex items-center gap-2">
          <span className="mg-live-dot" />
          Registry
        </div>
        <h2 className="mt-2 font-display text-2xl md:text-3xl font-semibold tracking-tight text-ink-strong">
          Registry leaderboards
        </h2>
        <p className="mt-2 text-sm text-ink-muted leading-relaxed">
          Ten boards computed live from registry data — economic-opportunity boards for miners and
          validators deciding where to register or validate, plus operational boards ranking health,
          latency, completeness, and reliability.
        </p>
      </div>

      <BoardGroup title="Economic opportunity" boards={ECONOMIC_BOARDS} data={boards} />
      <BoardGroup title="Operational" boards={OPERATIONAL_BOARDS} data={boards} />
    </section>
  );
}

function BoardGroup({
  title,
  boards,
  data,
}: {
  title: string;
  boards: BoardSpec[];
  data: Record<LeaderboardBoardKey, LeaderboardRow[]>;
}) {
  return (
    <div className="space-y-4">
      <h3 className="mg-section-rule mg-type-label uppercase text-ink-muted">{title}</h3>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {boards.map((board) => (
          <BoardCard
            key={board.key}
            label={board.label}
            blurb={board.blurb}
            rows={(data[board.key] ?? []).slice(0, ROWS_PER_BOARD)}
            metric={board.metric}
          />
        ))}
      </div>
    </div>
  );
}

function BoardCard({
  label,
  blurb,
  rows,
  metric,
}: {
  label: string;
  blurb: string;
  rows: LeaderboardRow[];
  metric: (row: LeaderboardRow) => string | null;
}) {
  return (
    <Panel as="div" dense>
      <div className="mb-1 mg-type-micro text-ink-muted">{label}</div>
      <p className="mb-3 text-xs text-ink-subtle leading-relaxed">{blurb}</p>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-2 py-3 text-center text-xs text-ink-subtle">
          No ranked subnets yet.
        </p>
      ) : (
        <ol className="space-y-0.5">
          {rows.map((row, i) => (
            <li key={row.netuid}>
              <Link
                to="/subnets/$netuid"
                params={{ netuid: row.netuid }}
                className="mg-row-hover flex items-center justify-between gap-2 rounded-md px-2 py-1.5"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="w-4 shrink-0 text-right font-mono text-[10px] text-ink-muted tabular-nums">
                    {i + 1}
                  </span>
                  <BrandIcon
                    size={18}
                    name={row.name ?? `Subnet ${row.netuid}`}
                    fallback={row.netuid}
                    netuid={row.netuid}
                    subnetSlug={row.slug}
                  />
                  <span className="truncate text-sm text-ink-strong">
                    {row.name ?? `Subnet ${row.netuid}`}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[12px] tabular-nums text-ink-muted">
                  {metric(row) ?? "—"}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
