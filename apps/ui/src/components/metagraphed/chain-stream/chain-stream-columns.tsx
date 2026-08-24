import { CopyableCode, truncateIdentifier, type DataTableColumn } from "@jsonbored/ui-kit";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { formatDecimal, formatNumber } from "@/lib/metagraphed/format";
import type { ChainEvent, Extrinsic } from "@/lib/metagraphed/types";
import { cadenceTint, callLabel, eventLabel, type BlockRow } from "./chain-stream-logic";

/**
 * The column sets for the three chain streams (#11620), beside the
 * derivations they call rather than inside the page: -chain-stream-page.tsx
 * is three pages' worth of wiring already, and a column list is a description
 * of a table, not of a route.
 */

export function blockColumns(): DataTableColumn<BlockRow>[] {
  return [
    {
      key: "height",
      label: "Height",
      kind: "link",
      width: 130,
      value: (row) => row.block_number,
      href: (row) => `/blocks/${row.block_number}`,
      format: (value) => (typeof value === "number" ? `#${formatNumber(value)}` : "—"),
    },
    // In the menu, not the table. Blocks arrive twelve seconds apart, so at any
    // relative-time granularity a reader can read, fifty consecutive blocks are
    // all "11d ago" -- or all "10m ago" at the head (#11696). What varies down
    // this list is the HEIGHT, which leads, and the block time, which has its
    // own column; the head's own age is in the page's liveness line.
    {
      key: "age",
      label: "Age",
      kind: "time",
      width: 110,
      demote: true,
      value: (row) => row.observed_at ?? null,
    },
    {
      key: "author",
      label: "Author",
      kind: "identifier",
      value: (row) => row.author ?? null,
      render: (row) => (
        <AddressDisplay
          ss58={row.author}
          compact
          fallback={row.author ? <CopyableCode value={row.author} className="max-w-full" /> : "—"}
        />
      ),
    },
    {
      key: "extrinsics",
      label: "Extrinsics",
      kind: "number",
      align: "right",
      width: 110,
      value: (row) => row.extrinsic_count ?? null,
    },
    {
      key: "events",
      label: "Events",
      kind: "number",
      align: "right",
      width: 100,
      value: (row) => row.event_count ?? null,
    },
    {
      key: "block_time",
      label: "Block time",
      kind: "tint",
      align: "right",
      width: 120,
      value: (row) => row.block_time_ms,
      tint: (row) => cadenceTint(row.block_time_ms),
      format: (value) => (typeof value === "number" ? `${formatDecimal(value / 1000, 1)}s` : "—"),
      definition:
        "Time since the previous block, derived from consecutive observations — so the oldest row on a page has none. The tint is centred on the 12s target: pale is early, dark is late.",
    },
    {
      key: "hash",
      label: "Hash",
      kind: "identifier",
      demote: true,
      value: (row) => row.block_hash,
      format: (value) => (typeof value === "string" ? truncateIdentifier(value) : "—"),
    },
    {
      key: "parent",
      label: "Parent",
      kind: "identifier",
      demote: true,
      value: (row) => row.parent_hash ?? null,
      format: (value) => (typeof value === "string" ? truncateIdentifier(value) : "—"),
    },
  ];
}

export function extrinsicColumns(): DataTableColumn<Extrinsic>[] {
  return [
    {
      key: "hash",
      label: "Hash",
      kind: "link",
      width: 150,
      value: (row) => row.extrinsic_hash ?? null,
      href: (row) => (row.extrinsic_hash ? `/extrinsics/${row.extrinsic_hash}` : undefined),
      format: (value) => (typeof value === "string" && value ? truncateIdentifier(value) : "—"),
    },
    {
      key: "block",
      label: "Block",
      kind: "link",
      width: 130,
      value: (row) => row.block_number ?? null,
      href: (row) => (row.block_number == null ? undefined : `/blocks/${row.block_number}`),
      format: (value, row) =>
        typeof value === "number"
          ? `#${formatNumber(value)}${row.extrinsic_index == null ? "" : `·${row.extrinsic_index}`}`
          : "—",
    },
    { key: "call", label: "Call", value: (row) => callLabel(row.call_module, row.call_function) },
    {
      key: "signer",
      label: "Signer",
      kind: "identifier",
      value: (row) => row.signer ?? null,
      render: (row) => (
        <AddressDisplay
          ss58={row.signer}
          compact
          fallback={row.signer ? <CopyableCode value={row.signer} className="max-w-full" /> : "—"}
        />
      ),
    },
    {
      key: "result",
      label: "Result",
      kind: "status",
      width: 100,
      // `success == null` is the tier having no reading, which is not a
      // failure -- it falls through to the em-dash rather than to "failed".
      value: (row) => (row.success == null ? null : row.success ? "ok" : "failed"),
    },
    {
      // The CAPTURE time, not the chain's. Every row in a polled page was
      // observed in the same pass, so the column reads one value on all fifty
      // of them -- forty rows of "17h ago" (#11696). It stays available in the
      // column menu, because "when did we see this" is a real question about a
      // single row; it is not something a reader scans down a column, and the
      // row's block already dates it.
      key: "observed",
      label: "Observed",
      kind: "time",
      width: 110,
      demote: true,
      value: (row) => row.observed_at ?? null,
    },
    {
      key: "fee",
      label: "Fee",
      kind: "number",
      align: "right",
      demote: true,
      value: (row) => (typeof row.fee_tao === "number" ? row.fee_tao : null),
    },
    {
      key: "tip",
      label: "Tip",
      kind: "number",
      align: "right",
      demote: true,
      value: (row) => (typeof row.tip_tao === "number" ? row.tip_tao : null),
    },
  ];
}

export function eventColumns(): DataTableColumn<ChainEvent>[] {
  return [
    {
      key: "block",
      label: "Block",
      kind: "link",
      width: 130,
      value: (row) => row.block_number,
      href: (row) => (row.block_number == null ? undefined : `/blocks/${row.block_number}`),
      format: (value, row) =>
        typeof value === "number"
          ? `#${formatNumber(value)}${row.event_index == null ? "" : `·${row.event_index}`}`
          : "—",
    },
    { key: "kind", label: "Event", width: 280, value: (row) => eventLabel(row) },
    // Bounded: unbounded it took 617px of a 1254px table on a 1198px card and
    // pushed the last column off the edge (#11696).
    {
      key: "summary",
      label: "Summary",
      kind: "text",
      width: 560,
      value: (row) => asText(row.summary),
    },
    {
      key: "phase",
      label: "Phase",
      kind: "status",
      width: 120,
      demote: true,
      value: (row) => asText(row.phase),
    },
    {
      // The CAPTURE time, not the chain's. Every row in a polled page was
      // observed in the same pass, so the column reads one value on all fifty
      // of them -- forty rows of "17h ago" (#11696). It stays available in the
      // column menu, because "when did we see this" is a real question about a
      // single row; it is not something a reader scans down a column, and the
      // row's block already dates it.
      key: "observed",
      label: "Observed",
      kind: "time",
      width: 110,
      demote: true,
      value: (row) => row.observed_at ?? null,
    },
  ];
}

/** A string worth rendering, or null so the cell falls to the em-dash. */
export function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
