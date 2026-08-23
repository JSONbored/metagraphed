import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { Coins } from "lucide-react";
import { CopyButton, DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { classNames } from "@/lib/metagraphed/format";
import { resolveAddress } from "@/lib/metagraphed/resolve-address";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { RouterLink } from "@/components/metagraphed/router-link";
import { StakeUnstakeModal } from "@/components/metagraphed/stake-unstake-modal";
import { taoCompact, scoreStr, SponsoredBadge } from "@/components/metagraphed/neuron-format";
import {
  annualizedDelegatorApyPct,
  formatApyPct,
  formatTakePct,
} from "@/lib/metagraphed/validator-apy";
import type { MetagraphNeuron } from "@/lib/metagraphed/types";

type SortField =
  | "uid"
  | "stake_tao"
  | "emission_tao"
  | "rank"
  | "trust"
  | "consensus"
  | "dividends"
  | "validator_trust"
  | "take";

/** Which scoring columns each variant surfaces, in render order. */
type NeuronTableVariant = "miner" | "validator";

// `featured` (the sponsored-placement pin, #5166) must NEVER be sortable —
// sort/rank stays strictly objective (stake, trust, consensus, etc.) so a
// paid placement can never distort the neutral comparison. `SortField` simply
// has no `featured` member, so it can't be added here without a type error;
// neuron-table.test.ts also asserts this set never contains "featured" at
// runtime as a second line of defense if that type is ever loosened.
/**
 * The columns this table sorts numerically.
 *
 * Constructed as `Set<SortField>` so the membership list below stays checked
 * against the column union, but EXPOSED as `ReadonlySet<string>` because the
 * field being asked about arrives from the URL and is a string until something
 * proves otherwise. Typing the query side as `SortField` did not make the
 * lookup safer -- it just meant callers asserted, including the test whose
 * entire job is asking whether "featured" is in here.
 */
export const NUMERIC_FIELDS: ReadonlySet<string> = new Set<SortField>([
  "uid",
  "stake_tao",
  "emission_tao",
  "rank",
  "trust",
  "consensus",
  "dividends",
  "validator_trust",
  "take",
]);

/**
 * Validator scoring lives in validator_trust, but the chain only populates it
 * for permitted neurons — fall back to plain `trust` when the payload omits it.
 */
function validatorTrustValue(n: MetagraphNeuron): number | null | undefined {
  return n.validator_trust ?? n.trust;
}

function sortValue(n: MetagraphNeuron, field: SortField): number {
  const v = field === "validator_trust" ? validatorTrustValue(n) : n[field];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // Inactive UIDs have null rank/emission; sink them to the bottom of a desc sort.
  return field === "rank" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
}

const tao = (value: unknown) => taoCompact(typeof value === "number" ? value : null);
const score = (value: unknown) => scoreStr(typeof value === "number" ? value : null);

/** The permit is a chain-derived trust fact, so it reads as a chip, not a tick. */
function PermitCell({ permit }: { permit: boolean | null | undefined }) {
  if (!permit) return <span className="text-10 text-ink-subtle-text">—</span>;
  return (
    <span className="inline-flex items-center rounded border border-accent/40 bg-accent-surface px-1.5 py-0.5 text-13 text-accent-text">
      Validator
    </span>
  );
}

function HotkeyCell({ n, isValidator }: { n: MetagraphNeuron; isValidator: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {n.featured ? <SponsoredBadge /> : null}
      {n.hotkey ? (
        isValidator ? (
          <>
            {/* Validator rows link to the dedicated /validators/$hotkey page,
                not the generic /accounts/$ss58 lookup that AddressDisplay's own
                link targets, so this stays a manually-composed Link +
                CopyButton pair rather than AddressDisplay -- the text is still
                upgraded through the shared resolveAddress ladder. */}
            <Link
              to="/validators/$hotkey"
              params={{ hotkey: n.hotkey }}
              className="truncate text-ink-muted hover:text-ink hover:underline"
              title={n.hotkey}
            >
              {resolveAddress(n.hotkey).display}
            </Link>
            <CopyButton value={n.hotkey} label="hotkey" compact />
          </>
        ) : (
          <AddressDisplay
            ss58={n.hotkey}
            fallback={<>{n.hotkey}</>}
            compact
            valueClassName="text-ink-muted hover:text-ink"
          />
        )
      ) : (
        "—"
      )}
    </span>
  );
}

/**
 * Shared sortable neuron table for the metagraph + validator panels. Rows
 * drill into a per-UID snapshot via `onSelect` (the parent owns the `?uid=`
 * search param). Every numeric cell is null-safe — inactive UIDs render an
 * em-dash rather than a misleading zero/NaN.
 */
export function NeuronTable({
  netuid,
  rows,
  variant = "miner",
  defaultField = "stake_tao",
  onSelect,
  selectedUid,
}: {
  netuid: number;
  rows: MetagraphNeuron[];
  /**
   * `miner` (default) shows rank/trust/consensus — the metagraph leaderboard.
   * `validator` swaps those for dividends/validator-trust, the metrics that
   * actually score a validator (rank is null, consensus ~0 for validators).
   */
  variant?: NeuronTableVariant;
  defaultField?: SortField;
  onSelect?: (uid: number) => void;
  selectedUid?: number | null;
}) {
  const isValidator = variant === "validator";

  // The table owns interactive sorting; this only fixes the order the reader
  // first sees, which is the leaderboard's whole point.
  const sorted = useMemo(() => {
    const dir = defaultField === "uid" || defaultField === "rank" ? 1 : -1;
    return [...rows].sort(
      (a, b) => (sortValue(a, defaultField) - sortValue(b, defaultField)) * dir,
    );
  }, [rows, defaultField]);

  const columns = useMemo<Array<DataTableColumn<MetagraphNeuron>>>(() => {
    const scoring: Array<DataTableColumn<MetagraphNeuron>> = isValidator
      ? [
          {
            key: "dividends",
            label: "Dividends",
            kind: "number",
            sortable: true,
            value: (n) => n.dividends,
            format: score,
          },
          {
            key: "validator_trust",
            label: "Val Trust",
            kind: "number",
            sortable: true,
            value: (n) => validatorTrustValue(n),
            format: score,
          },
          {
            key: "take",
            label: "Take",
            kind: "number",
            sortable: true,
            value: (n) => n.take,
            format: (v) => formatTakePct(typeof v === "number" ? v : null),
          },
          {
            key: "apy",
            label: "Est. APY",
            kind: "number",
            value: (n) =>
              annualizedDelegatorApyPct(n.emission_tao ?? 0, n.stake_tao ?? 0, n.take) ?? null,
            format: (v) => formatApyPct(typeof v === "number" ? v : null),
          },
        ]
      : [
          {
            key: "rank",
            label: "Rank",
            kind: "number",
            sortable: true,
            value: (n) => n.rank,
          },
          {
            key: "trust",
            label: "Trust",
            kind: "number",
            sortable: true,
            value: (n) => n.trust,
            format: score,
          },
          {
            key: "consensus",
            label: "Consensus",
            kind: "number",
            sortable: true,
            value: (n) => n.consensus,
            format: score,
          },
        ];

    const base: Array<DataTableColumn<MetagraphNeuron>> = [
      {
        key: "uid",
        label: "UID",
        align: "left",
        sortable: true,
        value: (n) => n.uid,
        render: (n) => (
          <span
            className={classNames(
              "font-mono tabular-nums",
              selectedUid === n.uid ? "text-accent" : "text-ink-strong",
            )}
          >
            {n.uid}
          </span>
        ),
      },
      {
        key: "hotkey",
        label: "Hotkey",
        value: (n) => n.hotkey ?? null,
        render: (n) => <HotkeyCell n={n} isValidator={isValidator} />,
      },
      {
        key: "stake_tao",
        label: "Stake τ",
        kind: "number",
        sortable: true,
        value: (n) => n.stake_tao,
        format: tao,
      },
      {
        key: "emission_tao",
        label: "Emission τ",
        kind: "number",
        sortable: true,
        value: (n) => n.emission_tao,
        format: tao,
      },
      ...scoring,
      {
        key: "permit",
        label: "Permit",
        align: "left",
        value: (n) => (n.validator_permit ? "Validator" : null),
        render: (n) => <PermitCell permit={n.validator_permit} />,
      },
    ];

    if (!isValidator) return base;
    return [
      ...base,
      {
        key: "delegate",
        label: "Delegate",
        align: "right",
        value: () => null,
        render: (n) =>
          n.hotkey ? (
            <StakeUnstakeModal
              hotkey={n.hotkey}
              netuid={netuid}
              trigger={(open) => (
                <button
                  type="button"
                  onClick={open}
                  className="inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1 text-13 font-medium text-ink-strong transition-colors hover:border-accent/50 hover:text-accent"
                >
                  <Coins className="size-3 text-ink-muted" aria-hidden />
                  Delegate
                </button>
              )}
            />
          ) : null,
      },
    ];
  }, [isValidator, netuid, selectedUid]);

  return (
    <DataTable
      rows={sorted}
      columns={columns}
      rowKey={(n) => String(n.uid)}
      caption={isValidator ? `Subnet ${netuid} validators` : `Subnet ${netuid} neurons`}
      link={RouterLink}
      // Ten labelled metrics per row read as a card below 640px; a horizontal
      // scroll there hides the scoring columns behind a gesture nobody makes.
      mobile="cards"
      onRowActivate={onSelect ? (n) => onSelect(n.uid) : undefined}
    />
  );
}
