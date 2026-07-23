import { classNames } from "@/lib/metagraphed/format";

const provenance: Record<string, { label: string; description: string; className: string }> = {
  native: {
    label: "Native",
    description: "Native chain metadata",
    className: "border-ink-strong/40 text-ink-strong",
  },
  "candidate-discovered": {
    label: "Candidate",
    description: "Discovered lead; not yet verified",
    className: "border-dashed border-ink-subtle text-ink-muted",
  },
  "community-seeded": {
    label: "Community",
    description: "Community-sourced registry metadata",
    className: "border-curation-seeded/45 text-curation-seeded",
  },
  "machine-verified": {
    label: "Machine",
    description: "Automatically verified registry metadata",
    className: "border-curation-machine/45 text-curation-machine",
  },
  "maintainer-reviewed": {
    label: "Reviewed",
    description: "Reviewed by a registry maintainer",
    className: "border-curation-verified/45 bg-primary-soft text-curation-verified",
  },
  "adapter-backed": {
    label: "Adapter",
    description: "Backed by a first-party registry adapter",
    className: "border-curation-adapter/45 text-curation-adapter",
  },
};

export function ProvenanceChip({ level, className }: { level?: string; className?: string }) {
  const item = provenance[level ?? ""] ?? {
    label: level || "Unknown",
    description: "Curation provenance not classified",
    className: "border-border text-ink-muted",
  };

  return (
    <span
      tabIndex={0}
      title={item.description}
      aria-label={`${item.label}: ${item.description}`}
      className={classNames(
        "mg-focus-ring inline-flex items-center rounded border bg-transparent px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider",
        item.className,
        className,
      )}
    >
      {item.label}
    </span>
  );
}
