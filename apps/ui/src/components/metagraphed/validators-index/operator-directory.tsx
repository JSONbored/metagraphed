import { useMemo, useState, type CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import { DataTable, sortRows, type DataTableColumn, type SortState } from "@jsonbored/ui-kit";
import { RouterLink } from "@/components/metagraphed/router-link";
import { EmptyState } from "@/components/metagraphed/states";
import { useValidatorsCompareSelection } from "@/lib/metagraphed/validators-compare-selection";
import { formatNumber, formatPct } from "@/lib/metagraphed/format";
import { API_BASE } from "@/lib/metagraphed/config";
import type { ValidatorsSearch } from "@/routes/validators.index";
import {
  filterOperators,
  fmtStake,
  hotkeyColor,
  hotkeyComposition,
  shortKey,
  takeLabel,
  type OperatorRow,
} from "./validators-index-logic";

type RankedOperator = OperatorRow & { rank: number };

const SORTS = [
  { key: "stake", label: "Stake", dir: "desc" },
  { key: "apy", label: "APY", dir: "desc" },
  { key: "take", label: "Take", dir: "asc" },
  { key: "keys", label: "Hotkeys", dir: "desc" },
] as const;

function StakeProfile({ row }: { row: OperatorRow }) {
  const segments = hotkeyComposition(row.keys);
  const percent = (share: number) => Math.round(share * 10000) / 100;
  const background =
    segments.length === 1
      ? segments[0]!.color
      : `linear-gradient(90deg,${segments.map((segment) => `${segment.color} ${percent(segment.offset)}% ${percent(segment.offset + segment.share)}%`).join(",")})`;
  const largest = segments.length > 0 && row.keyCount > 1 ? formatPct(segments[0]!.share, 1) : null;
  return (
    <span
      className="mg-op-profile"
      role="img"
      aria-label={
        segments.length
          ? `Stake across ${row.keyCount} ${row.keyCount === 1 ? "hotkey" : "hotkeys"}${largest ? `; largest ${largest}` : ""}`
          : "No positive stake listed"
      }
      data-empty={segments.length === 0 || undefined}
      style={segments.length ? ({ "--stake-profile": background } as CSSProperties) : undefined}
    >
      <span>
        {formatNumber(row.keyCount)} {row.keyCount === 1 ? "hotkey" : "hotkeys"}
      </span>
      {largest ? <span>Largest {largest}</span> : null}
      {segments.length === 0 ? <span>No positive stake listed</span> : null}
    </span>
  );
}

function OperatorDetails({ row }: { row: OperatorRow }) {
  const [all, setAll] = useState(false);
  const keys = all ? row.keys : row.keys.slice(0, 8);
  return (
    <div className="mg-operator-details">
      <div className="mg-operator-details-head">
        <div>
          <h3>{row.name}</h3>
          <p>Stake and fees across this operator’s validator hotkeys.</p>
        </div>
        <RouterLink href={`/validators/${row.primaryHotkey}`} className="mg-operator-detail-link">
          Open largest hotkey <span aria-hidden="true">↗</span>
        </RouterLink>
      </div>
      <dl className="mg-operator-details-facts">
        <div>
          <dt>Operator stake</dt>
          <dd>{fmtStake(row.totalStakeTao)}</dd>
        </div>
        <div>
          <dt>Hotkeys</dt>
          <dd>{formatNumber(row.keyCount)}</dd>
        </div>
        <div>
          <dt>Memberships</dt>
          <dd>{formatNumber(row.memberships)}</dd>
        </div>
        <div>
          <dt>Nominators</dt>
          <dd>{row.nominators === null ? "—" : formatNumber(row.nominators)}</dd>
        </div>
      </dl>
      <p className="mg-operator-details-note">
        Memberships count registrations across hotkeys, including repeated subnets.
      </p>
      <ul className="mg-operator-keys" aria-label={`${row.name} hotkeys`}>
        {keys.map((key) => (
          <li key={key.hotkey}>
            <RouterLink href={`/validators/${key.hotkey}`}>
              <i
                style={{ "--swatch": hotkeyColor(key.hotkey) } as CSSProperties}
                aria-hidden="true"
              />
              <span title={key.hotkey}>{shortKey(key.hotkey)}</span>
            </RouterLink>
            <span>{fmtStake(key.totalStakeTao)}</span>
            <span>{key.take === null ? "Take unavailable" : `${formatPct(key.take, 1)} take`}</span>
          </li>
        ))}
      </ul>
      {row.keyCount > 8 ? (
        <button type="button" className="mg-operator-show-keys" onClick={() => setAll(!all)}>
          {all ? "Show largest 8" : `Show all ${formatNumber(row.keyCount)} hotkeys`}
        </button>
      ) : null}
    </div>
  );
}

export function OperatorDirectory({
  operators,
  search,
  onSearch,
}: {
  operators: readonly OperatorRow[];
  search: ValidatorsSearch;
  onSearch: (next: Partial<ValidatorsSearch>) => void;
}) {
  const [sort, setSort] = useState<SortState | null>({ key: "stake", dir: "desc" });
  const selection = useValidatorsCompareSelection();
  const names = useMemo(
    () => new Map(operators.map((row) => [row.primaryHotkey, row.name])),
    [operators],
  );
  const ranked = useMemo(
    () => operators.map((row, index) => ({ ...row, rank: index + 1 })),
    [operators],
  );
  const filtered = filterOperators(ranked, {
    q: search.q,
    minStake: search.minStake,
    namedOnly: search.named,
  }) as RankedOperator[];
  const filtersActive = Boolean(search.q || search.minStake || search.named);
  const columns: DataTableColumn<RankedOperator>[] = [
    {
      key: "rank",
      label: "Rank",
      width: "6%",
      kind: "number",
      value: (row) => row.rank,
      render: (row) => (
        <span className="mg-operator-rank">{String(row.rank).padStart(2, "0")}</span>
      ),
    },
    {
      key: "name",
      label: "Operator",
      width: "25%",
      kind: "text",
      sortable: true,
      lead: true,
      value: (row) => row.name,
      render: (row) => (
        <span className="mg-op-name">
          {row.name}
          <small>{row.named ? shortKey(row.primaryHotkey) : "Identity not declared"}</small>
        </span>
      ),
    },
    {
      key: "stake",
      label: "Total stake",
      width: "14%",
      kind: "number",
      sortable: true,
      value: (row) => row.totalStakeTao,
      format: (value) => (typeof value === "number" ? fmtStake(value) : "—"),
      render: (row) => (
        <span className="mg-op-stake">
          {fmtStake(row.totalStakeTao)}
          <small>
            {row.dominance === null
              ? "Share unavailable"
              : `${formatPct(row.dominance, 1)} of listed`}
          </small>
        </span>
      ),
    },
    {
      key: "apy",
      label: "Est. APY",
      width: "10%",
      kind: "number",
      sortable: true,
      value: (row) => row.apyEstimate,
      format: (value) => (typeof value === "number" ? formatPct(value, 1) : "—"),
      render: (row) => <em>{row.apyEstimate === null ? "—" : formatPct(row.apyEstimate, 1)}</em>,
      definition: "Estimated APY",
    },
    {
      key: "take",
      label: "Take",
      width: "10%",
      kind: "number",
      sortable: true,
      value: (row) => takeLabel(row.takeMin, row.takeMax),
      format: (value) => String(value).replace("%–", "–"),
      definition: "Take",
    },
    {
      key: "keys",
      label: "Stake by hotkey",
      width: "28%",
      kind: "number",
      sortable: true,
      align: "left",
      value: (row) => row.keys.map((key) => `${key.hotkey}: ${key.totalStakeTao} TAO`).join("; "),
      render: (row) => <StakeProfile row={row} />,
    },
    {
      key: "compare",
      label: "Compare",
      width: "7%",
      kind: "text",
      value: () => "",
      render: (row) => {
        const checked = selection.has(row.primaryHotkey);
        const disabled = !checked && selection.selected.length >= selection.max;
        return (
          <button
            type="button"
            role="checkbox"
            className="mg-operator-check mg-tap-target"
            aria-checked={checked}
            aria-label={`${checked ? "Remove" : "Add"} ${row.name} ${checked ? "from" : "to"} comparison`}
            disabled={disabled}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              selection.toggle(row.primaryHotkey);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {checked ? <span aria-hidden="true">✓</span> : null}
          </button>
        );
      },
    },
    {
      key: "memberships",
      label: "Memberships",
      kind: "number",
      sortable: true,
      demote: true,
      value: (row) => row.memberships,
    },
    {
      key: "nominators",
      label: "Nominators",
      kind: "number",
      sortable: true,
      demote: true,
      value: (row) => row.nominators,
      definition: "Nominators",
    },
    {
      key: "dominance",
      label: "Dominance",
      kind: "number",
      sortable: true,
      demote: true,
      value: (row) => row.dominance,
      format: (value) => (typeof value === "number" ? formatPct(value, 2) : "—"),
    },
    {
      key: "uids",
      label: "UIDs",
      kind: "number",
      sortable: true,
      demote: true,
      value: (row) => row.uidCount,
    },
    {
      key: "emission",
      label: "Emission",
      kind: "number",
      sortable: true,
      demote: true,
      value: (row) => row.totalEmissionTao,
      format: (value) => (typeof value === "number" ? fmtStake(value) : "—"),
    },
    {
      key: "coldkey",
      label: "Coldkey",
      kind: "identifier",
      demote: true,
      value: (row) => row.coldkey ?? "—",
    },
  ];
  const sorted = sortRows(filtered, sort, (row, key) => {
    if (key === "take") return row.takeMax;
    if (key === "keys") return row.keyCount;
    return columns.find((column) => column.key === key)?.value?.(row);
  });
  const namedCount = operators.filter((row) => row.named).length;
  const compareReady = selection.selected.length >= 2;

  return (
    <div className="mg-operator-directory">
      <div className="mg-operator-toolbar">
        <fieldset>
          <legend>Show</legend>
          <div className="mg-operator-segments">
            <button
              type="button"
              aria-pressed={!search.named}
              onClick={() => onSearch({ named: false })}
            >
              All operators <span>{formatNumber(operators.length)}</span>
            </button>
            <button
              type="button"
              aria-pressed={search.named}
              onClick={() => onSearch({ named: true })}
            >
              Named <span>{formatNumber(namedCount)}</span>
            </button>
          </div>
        </fieldset>
        <fieldset>
          <legend>Sort by</legend>
          <div className="mg-operator-segments">
            {SORTS.map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={sort?.key === option.key}
                aria-label={`Sort by ${option.key === "take" ? "maximum take" : option.label}${sort?.key === option.key ? `, ${sort.dir === "desc" ? "high to low" : "low to high"}` : ""}`}
                onClick={() =>
                  setSort({
                    key: option.key,
                    dir:
                      sort?.key === option.key
                        ? sort.dir === "desc"
                          ? "asc"
                          : "desc"
                        : option.dir,
                  })
                }
              >
                {option.label}{" "}
                {sort?.key === option.key ? (
                  <span aria-hidden="true">{sort.dir === "desc" ? "↓" : "↑"}</span>
                ) : null}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="mg-operator-compare-control">
          <span>Largest hotkeys</span>
          <Link
            to="/compare"
            search={{ validators: selection.selected.join(",") }}
            className="mg-operator-compare-link"
            aria-disabled={!compareReady || undefined}
            tabIndex={compareReady ? 0 : -1}
            onClick={(event) => {
              if (!compareReady) event.preventDefault();
            }}
          >
            Compare <b>{selection.selected.length}</b>
          </Link>
        </div>
      </div>
      <div className="mg-operator-search-row">
        <input
          type="search"
          aria-label="Search operators"
          placeholder="Search operator, hotkey or coldkey"
          value={search.q}
          onChange={(event) => onSearch({ q: event.target.value })}
        />
        <select
          aria-label="Minimum stake"
          value={String(search.minStake)}
          onChange={(event) => onSearch({ minStake: Number(event.target.value) })}
        >
          <option value="0">Any stake</option>
          <option value="1000">1kτ and up</option>
          <option value="10000">10kτ and up</option>
          <option value="100000">100kτ and up</option>
        </select>
        {filtersActive ? (
          <button type="button" onClick={() => onSearch({ q: "", minStake: 0, named: false })}>
            Clear filters
          </button>
        ) : null}
      </div>
      {selection.selected.length > 0 ? (
        <div className="mg-operator-selection" aria-label="Selected operators">
          {selection.selected.map((hotkey) => (
            <button
              key={hotkey}
              type="button"
              title={names.get(hotkey) ?? hotkey}
              onClick={() => selection.remove(hotkey)}
              aria-label={`Remove ${names.get(hotkey) ?? shortKey(hotkey)} from comparison`}
            >
              <span>{names.get(hotkey) ?? shortKey(hotkey)}</span>
              <span aria-hidden="true">×</span>
            </button>
          ))}
          <button type="button" onClick={selection.clear}>
            Clear selection
          </button>
        </div>
      ) : null}
      <DataTable
        key={`${search.q}:${search.minStake}:${search.named}:${sort?.key}:${sort?.dir}`}
        className="mg-dt--operators"
        caption={
          filtersActive
            ? `${formatNumber(filtered.length)} of ${formatNumber(operators.length)} operators`
            : "Operators"
        }
        captionCount={filtersActive ? null : operators.length}
        rows={sorted}
        columns={columns}
        sort={sort}
        onSort={setSort}
        rowKey={(row) => row.key}
        rowHref={(row) => `/validators/${row.primaryHotkey}`}
        link={RouterLink}
        mobile="cards"
        compactMobileLabels
        source="validator-operator"
        storageKey="validator-profile-columns"
        expand={(row) => (row.keyCount > 1 ? <OperatorDetails row={row} /> : null)}
        empty={
          <EmptyState
            title={filtersActive ? "No operators match these filters" : "No validators indexed yet"}
            description={
              filtersActive
                ? "Clear the search or lower the minimum stake."
                : "The directory fills as validator records are indexed."
            }
            action={
              filtersActive
                ? undefined
                : {
                    label: "Open /api/v1/validators",
                    href: `${API_BASE}/api/v1/validators`,
                    external: true,
                  }
            }
          />
        }
      />
      <p className="mg-operator-footnote">
        Charts show each operator’s stake split across hotkeys. Comparison opens the largest-stake
        hotkey. Take sorting uses the maximum fee.
      </p>
    </div>
  );
}
