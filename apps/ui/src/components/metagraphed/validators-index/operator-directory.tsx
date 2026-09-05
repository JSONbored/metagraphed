import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";
import {
  DataTable,
  FilterField,
  FilterSelect,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
  sortRows,
  type DataTableColumn,
  type SortState,
  type SectionNavLink,
} from "@jsonbored/ui-kit";
import { RouterLink } from "@/components/metagraphed/router-link";
import { EmptyState } from "@/components/metagraphed/states";
import { ValidatorCompareBar } from "@/components/metagraphed/compare-bar";
import { ValidatorCompareToggle } from "@/components/metagraphed/compare-toggle";
import { formatNumber, formatPct } from "@/lib/metagraphed/format";
import { API_BASE } from "@/lib/metagraphed/config";
import type { ValidatorsSearch } from "@/routes/validators.index";
import { filterOperators, shortKey, takeLabel, type OperatorRow } from "./validators-index-logic";

const SORTS = [
  { key: "name", label: "Name", dir: "asc" },
  { key: "keys", label: "Hotkeys", dir: "desc" },
  { key: "take", label: "Maximum observed take", dir: "asc" },
  { key: "memberships", label: "Memberships", dir: "desc" },
] as const;
const SORT_OPTIONS = SORTS.flatMap((option) =>
  (["asc", "desc"] as const).map((dir) => ({
    key: option.key,
    dir,
    label: `${option.label}: ${option.key === "name" ? (dir === "asc" ? "A to Z" : "Z to A") : dir === "asc" ? "low to high" : "high to low"}`,
  })),
);

/** A link cell keeps the count and its exact address outside disclosure buttons. */
const HotkeyCountLink: SectionNavLink = ({ href, children }) => {
  const hotkey = href.slice("/validators/".length);
  return (
    <span className="grid min-w-0 gap-1">
      <span>{children}</span>
      <Link
        to="/validators/$hotkey"
        params={{ hotkey }}
        className="truncate text-11 font-normal text-accent hover:underline"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        Hotkey {shortKey(hotkey)}
      </Link>
    </span>
  );
};

function OperatorDetails({ row }: { row: OperatorRow }) {
  const [all, setAll] = useState(false);
  const ordered = useMemo(
    () => [...row.keys].sort((a, b) => a.hotkey.localeCompare(b.hotkey)),
    [row.keys],
  );
  const keys = all ? ordered : ordered.slice(0, 8);
  return (
    <div className="grid gap-4 whitespace-normal" aria-label={`${row.name} hotkeys`}>
      <div className="grid min-w-0 gap-1">
        <h3 className="min-w-0 break-all text-13 font-medium text-ink-strong">{row.name}</h3>
        <p className="text-11 text-ink-muted">Open or compare a specific validator hotkey.</p>
      </div>
      <ul className="grid divide-y divide-border">
        {keys.map((key) => (
          <li
            key={key.hotkey}
            className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]"
          >
            <RouterLink
              href={`/validators/${key.hotkey}`}
              className="col-span-2 min-w-0 break-all text-13 text-accent hover:underline sm:col-span-1"
            >
              {key.hotkey}
            </RouterLink>
            <span className="text-11 tabular-nums text-ink-muted">
              {key.take === null ? "Take unavailable" : `${formatPct(key.take, 1)} take`}
            </span>
            <label className="flex min-h-11 items-center justify-end gap-2 whitespace-nowrap text-11">
              <ValidatorCompareToggle hotkey={key.hotkey} />
              <span>Compare</span>
            </label>
          </li>
        ))}
      </ul>
      {row.keyCount > 8 ? (
        <button
          type="button"
          className="min-h-11 justify-self-start text-11 text-accent hover:underline"
          onClick={() => setAll(!all)}
        >
          {all ? "Show first 8" : `Show all ${formatNumber(row.keyCount)} hotkeys`}
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
  const [optionsOpen, setOptionsOpen] = useState(false);
  const sort: SortState = { key: search.sort, dir: search.order };
  const names = useMemo(
    () =>
      new Map(operators.flatMap((row) => row.keys.map((key) => [key.hotkey, row.name] as const))),
    [operators],
  );
  const filtered = filterOperators(operators, { q: search.q, namedOnly: search.named });
  const filtersActive = Boolean(search.q || search.named);
  const optionsActive = search.named || search.sort !== "name" || search.order !== "asc";
  const setSort = (next: SortState | null) => {
    const option = SORTS.find((item) => item.key === next?.key);
    onSearch({ sort: option?.key ?? "name", order: next?.dir ?? "asc" });
  };
  const columns: DataTableColumn<OperatorRow>[] = [
    {
      key: "name",
      label: "Operator",
      width: "40%",
      kind: "text",
      sortable: true,
      lead: true,
      value: (row) => row.name,
      render: (row) => <span className="truncate font-medium text-ink-strong">{row.name}</span>,
    },
    {
      key: "keys",
      label: "Hotkeys",
      kind: "link",
      align: "right",
      sortable: true,
      value: (row) => row.keyCount,
      format: (value) => formatNumber(Number(value)),
      href: (row) =>
        `/validators/${[...row.keys].sort((a, b) => a.hotkey.localeCompare(b.hotkey))[0]!.hotkey}`,
    },
    {
      key: "take",
      label: "Observed take",
      kind: "text",
      sortable: true,
      value: (row) => {
        const known = row.keys.filter((key) => key.take !== null).length;
        const label = takeLabel(row.takeMin, row.takeMax);
        return known < row.keyCount ? `${label} (${known} of ${row.keyCount} hotkeys)` : label;
      },
      render: (row) => {
        const known = row.keys.filter((key) => key.take !== null).length;
        return (
          <span className="grid gap-1 tabular-nums">
            <span>{takeLabel(row.takeMin, row.takeMax)}</span>
            {known < row.keyCount ? (
              <small className="text-11 text-ink-muted">
                {known} of {row.keyCount} hotkeys
              </small>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "memberships",
      label: "Memberships",
      kind: "number",
      sortable: true,
      value: (row) => row.memberships,
      format: (value) => formatNumber(Number(value)),
    },
    {
      key: "addresses",
      label: "Hotkey addresses",
      kind: "text",
      demote: true,
      value: (row) => row.keys.map((key) => key.hotkey).join("; "),
    },
  ];
  const sorted = sortRows(filtered, sort, (row, key) => {
    if (key === "take") return row.takeMax;
    if (key === "name") return `${row.name.toLowerCase()}\u0000${row.key}`;
    return columns.find((column) => column.key === key)?.value?.(row);
  });
  const controls = (inSheet = false) => (
    <>
      <FilterField
        label="Identity"
        className={
          inSheet
            ? "gap-2 [&>span]:not-sr-only [&>span]:text-11 [&>span]:text-ink-muted"
            : undefined
        }
      >
        <FilterSelect
          className={
            inSheet ? "min-h-11 appearance-auto! border-border" : "min-h-11 appearance-auto!"
          }
          value={search.named ? "named" : "all"}
          onChange={(event) => onSearch({ named: event.target.value === "named" })}
        >
          <option value="all">All operators</option>
          <option value="named">Declares an identity</option>
        </FilterSelect>
      </FilterField>
      <FilterField
        label="Sort by"
        className={
          inSheet
            ? "gap-2 [&>span]:not-sr-only [&>span]:text-11 [&>span]:text-ink-muted"
            : undefined
        }
      >
        <FilterSelect
          className={
            inSheet ? "min-h-11 appearance-auto! border-border" : "min-h-11 appearance-auto!"
          }
          value={`${search.sort}:${search.order}`}
          onChange={(event) => {
            const next = SORT_OPTIONS.find(
              (option) => `${option.key}:${option.dir}` === event.target.value,
            );
            if (next) setSort(next);
          }}
        >
          {SORT_OPTIONS.map((option) => (
            <option key={`${option.key}:${option.dir}`} value={`${option.key}:${option.dir}`}>
              {option.label}
            </option>
          ))}
        </FilterSelect>
      </FilterField>
    </>
  );
  const reset = () => onSearch({ q: "", named: false, minStake: 0, sort: "name", order: "asc" });

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid min-w-0 flex-1 gap-2 text-11 text-ink-muted">
          Search operators
          <input
            type="search"
            placeholder="Name, hotkey or coldkey"
            className="min-h-11 w-full border border-border bg-canvas px-3 text-13 text-ink-strong outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
            value={search.q}
            onChange={(event) => onSearch({ q: event.target.value })}
          />
        </label>
        <div className="hidden items-end gap-3 lg:flex">{controls()}</div>
        <Sheet open={optionsOpen} onOpenChange={setOptionsOpen}>
          <SheetTrigger asChild>
            <button
              type="button"
              className="flex min-h-11 min-w-11 items-center justify-center border border-border bg-canvas text-ink-strong lg:hidden"
              aria-label={`Filter and sort operators${optionsActive ? ", options active" : ""}`}
            >
              <SlidersHorizontal width={16} height={16} aria-hidden="true" />
            </button>
          </SheetTrigger>
          <SheetContent
            side="bottom"
            className="max-h-[85dvh] overflow-y-auto border-border bg-canvas p-6 text-ink"
          >
            <SheetTitle>Filter and sort</SheetTitle>
            <SheetDescription>Refine the operator list.</SheetDescription>
            <div className="grid gap-4 py-4">{controls(true)}</div>
            <div className="flex flex-wrap items-center justify-between gap-3 pb-[env(safe-area-inset-bottom)]">
              <button type="button" className="min-h-11 text-13 text-accent" onClick={reset}>
                Reset
              </button>
              <button
                type="button"
                className="min-h-11 border border-border px-3 text-13"
                onClick={() => setOptionsOpen(false)}
              >
                Show {formatNumber(filtered.length)} operators
              </button>
            </div>
          </SheetContent>
        </Sheet>
        {filtersActive || optionsActive ? (
          <button type="button" className="min-h-11 text-11 text-accent" onClick={reset}>
            Reset
          </button>
        ) : null}
      </div>
      {search.minStake > 0 ? (
        <p className="text-11 text-ink-muted">
          Balance filtering is unavailable.{" "}
          <button
            type="button"
            className="min-h-11 text-accent underline"
            onClick={() => onSearch({ minStake: 0 })}
          >
            Clear this saved filter
          </button>
        </p>
      ) : null}
      <DataTable
        key={`${search.q}:${search.named}:${search.sort}:${search.order}`}
        className="max-lg:[&_.mg-dt-viewport]:max-h-none max-lg:[&_.mg-dt-viewport]:overflow-visible max-lg:[&_.mg-dt-viewport]:overscroll-auto max-lg:[&_.mg-dt-expansion>td]:px-4"
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
        link={HotkeyCountLink}
        mobile="cards"
        compactMobileLabels
        source="validator-operator"
        storageKey="validator-directory-columns"
        expand={(row) => <OperatorDetails row={row} />}
        empty={
          filtersActive ? (
            <EmptyState
              title="No operators match these filters"
              description="Clear the search or identity filter."
            />
          ) : (
            <EmptyState
              title="No validators indexed yet"
              description="The directory fills as validator records are indexed."
              action={{
                label: "Open /api/v1/validators",
                href: `${API_BASE}/api/v1/validators`,
                external: true,
              }}
            />
          )
        }
      />
      <ValidatorCompareBar names={names} />
      <p className="text-11 text-ink-muted">
        Memberships count registrations across hotkeys, including repeated subnets. Take is shown
        only where observed; sorting uses the maximum observed take.
      </p>
    </div>
  );
}
