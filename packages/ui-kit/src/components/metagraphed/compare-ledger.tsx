import type { CSSProperties, ReactNode } from "react";
import { classNames } from "@/lib/format";
import { Skeleton } from "@/components/metagraphed/skeleton";

/**
 * The side-by-side ledger (#11611): one column per entity, one row per fact,
 * grouped. The answer to "which of these should I pick?" — so the row says
 * which way is better and the ledger tints the winning cell, rather than
 * leaving the reader to compare two columns of numbers by eye.
 *
 * Two or three entities. Below 640px the entity columns scroll sideways and
 * the label column stays pinned, because a comparison whose labels have
 * scrolled away is not a comparison.
 */
export interface CompareEntity {
  key: string;
  name: string;
  /** Operator, domain, netuid — whatever qualifies the name. */
  sub?: string;
  href?: string;
  avatar?: ReactNode;
  /** Swaps this entity out; rendered as a small control in the header cell. */
  onChange?: () => void;
}

export interface CompareRow {
  key: string;
  label: string;
  /** One entry per entity, in `entities` order. `null` renders as "—". */
  values: ReadonlyArray<number | string | null>;
  /** Which direction wins. Omit for a row that has no winner. */
  better?: "high" | "low";
  format?: (value: number | string) => string;
  /** A chart under the value — a `LineWithWindow compact`, per entity. */
  spark?: ReadonlyArray<ReactNode | null>;
}

export interface CompareGroup {
  label: string;
  rows: readonly CompareRow[];
}

export interface CompareLedgerProps {
  entities: readonly CompareEntity[];
  groups: readonly CompareGroup[];
  /** Tint the winning cell of every row that declares a direction. */
  highlightBest?: boolean;
  /** Keep the selected columns and metric labels in place while values load. */
  loading?: boolean;
  ariaLabel: string;
  className?: string;
}

/**
 * Indices of the winning cells: the best value by `better`, or none at all
 * when the row does not declare a direction, when nothing is comparable, or
 * when the best value is tied — a tie has no winner to point at.
 */
export function bestIndices(row: CompareRow): number[] {
  if (!row.better) return [];
  const numeric = row.values.map((v) =>
    typeof v === "number" && Number.isFinite(v) ? v : null,
  );
  const present = numeric.filter((v): v is number => v !== null);
  if (present.length < 2) return [];
  const best =
    row.better === "high" ? Math.max(...present) : Math.min(...present);
  const winners = numeric.flatMap((v, i) => (v === best ? [i] : []));
  return winners.length === present.length ? [] : winners;
}

const defaultFormat = (value: number | string) =>
  typeof value === "number" ? value.toLocaleString("en-US") : value;

export function CompareLedger({
  entities,
  groups,
  highlightBest = true,
  loading = false,
  ariaLabel,
  className,
}: CompareLedgerProps) {
  return (
    <div
      className={classNames("mg-compare", className)}
      data-mg-compare=""
      style={{ "--mg-compare-cols": entities.length } as CSSProperties}
    >
      <div className="mg-compare-scroll">
        <table aria-busy={loading || undefined} aria-label={ariaLabel}>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Metric</span>
              </th>
              {entities.map((entity) => (
                <th key={entity.key} scope="col">
                  <span className="mg-compare-entity">
                    {entity.avatar ? (
                      <span className="mg-compare-avatar">{entity.avatar}</span>
                    ) : null}
                    <span className="mg-compare-names">
                      {entity.href ? (
                        <a href={entity.href}>{entity.name}</a>
                      ) : (
                        <strong>{entity.name}</strong>
                      )}
                      {entity.sub ? <span>{entity.sub}</span> : null}
                    </span>
                    {entity.onChange ? (
                      <button
                        type="button"
                        className="mg-compare-change"
                        onClick={entity.onChange}
                      >
                        Change
                      </button>
                    ) : null}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.label}>
              <tr className="mg-compare-group">
                <th scope="colgroup" colSpan={entities.length + 1}>
                  {group.label}
                </th>
              </tr>
              {group.rows.map((row) => {
                const winners =
                  loading || !highlightBest ? [] : bestIndices(row);
                const format = row.format ?? defaultFormat;
                return (
                  <tr key={row.key}>
                    <th scope="row">{row.label}</th>
                    {entities.map((entity, i) => {
                      const value = row.values[i] ?? null;
                      return (
                        <td
                          key={entity.key}
                          data-best={winners.includes(i) ? "true" : undefined}
                        >
                          <span className="mg-compare-value">
                            {loading ? (
                              <Skeleton className="ml-auto h-3 w-4/5 max-w-24" />
                            ) : value === null ? (
                              "—"
                            ) : (
                              format(value)
                            )}
                          </span>
                          {!loading && row.spark?.[i] ? (
                            <span className="mg-compare-spark">
                              {row.spark[i]}
                            </span>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}
