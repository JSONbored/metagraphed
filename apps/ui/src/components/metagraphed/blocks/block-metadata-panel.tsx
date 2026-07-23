import { Panel } from "@/components/metagraphed/primitives";
import { CopyButton, InfoTooltip } from "@jsonbored/ui-kit";
import type { Block } from "@/lib/metagraphed/types";
import { formatNumber } from "@/lib/metagraphed/format";

/**
 * Surfaces raw header fields the API returns via Block[key: string]: unknown
 * that the main detail card doesn't display. Includes spec/impl versions,
 * state/extrinsics roots, size (bytes), and any additional stringy/numeric
 * metadata the backend adds without frontend changes.
 */
export function BlockMetadataPanel({ block }: { block: Block }) {
  const rows = extractRows(block);
  if (rows.length === 0) return null;
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          Block metadata
          <InfoTooltip label="Raw header fields returned by the block API — runtime version, storage roots, and any additional annotations the backend attaches." />
        </span>
      }
      caption="Extended header data as returned by /api/v1/blocks/{ref}"
      flush
    >
      <dl className="divide-y divide-border/70">
        {rows.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-[minmax(120px,auto)_minmax(0,1fr)] gap-3 px-3 py-2 sm:px-4"
          >
            <dt className="mg-type-micro text-ink-muted inline-flex items-center gap-1.5">
              {r.label}
              {r.hint ? <InfoTooltip label={r.hint} /> : null}
            </dt>
            <dd className="min-w-0 flex items-center gap-1.5">
              {r.mono ? (
                <>
                  <span
                    className="font-mono text-[12px] text-ink-strong break-all md:hidden"
                    title={r.value}
                  >
                    {truncate(r.value, 28)}
                  </span>
                  <span className="hidden md:inline font-mono text-[12px] text-ink-strong break-all">
                    {r.value}
                  </span>
                  <CopyButton value={r.value} label={r.label} compact />
                </>
              ) : (
                <span className="font-mono text-[12px] text-ink-strong tabular-nums">
                  {r.value}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

interface Row {
  label: string;
  value: string;
  mono?: boolean;
  hint?: string;
}

function extractRows(block: Block): Row[] {
  const out: Row[] = [];
  const map: Array<[string, string, boolean, string?]> = [
    ["state_root", "State root", true, "Merkle root of runtime storage after this block executed."],
    [
      "extrinsics_root",
      "Extrinsics root",
      true,
      "Merkle root of the extrinsics list included in this block.",
    ],
    [
      "spec_version",
      "Spec version",
      false,
      "Runtime spec version at the time this block was executed.",
    ],
    ["impl_version", "Impl version", false, "Runtime implementation version."],
    ["spec_name", "Spec name", false],
    ["impl_name", "Impl name", false],
    ["size", "Size", false, "Encoded block size in bytes."],
    ["digest", "Digest", true, "Consensus digest logs (author seal / pre-runtime)."],
  ];
  for (const [key, label, mono, hint] of map) {
    const v = (block as Record<string, unknown>)[key];
    if (v == null || v === "") continue;
    let str: string;
    if (typeof v === "number") str = key === "size" ? `${formatNumber(v)} bytes` : formatNumber(v);
    else if (typeof v === "string") str = v;
    else {
      try {
        str = JSON.stringify(v);
      } catch {
        continue;
      }
    }
    out.push({ label, value: str, mono, hint });
  }
  return out;
}

function truncate(s: string, keep: number): string {
  if (s.length <= keep * 2 + 1) return s;
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}
