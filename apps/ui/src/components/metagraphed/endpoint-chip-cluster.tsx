import { Chip } from "@/components/metagraphed/primitives";
import type { Endpoint, RpcPool } from "@/lib/metagraphed/types";
import {
  endpointEligibility,
  ELIGIBILITY_LABEL,
  type PoolEligibility,
} from "@/lib/metagraphed/endpoint-pool";
import type { ChipTone } from "@/components/metagraphed/primitives/chip";

const ELIGIBILITY_CHIP_TONE: Record<PoolEligibility, ChipTone> = {
  "proxy-enabled": "accent",
  "pool-member": "default",
  "archive-capable": "ok",
  unassigned: "muted",
};

interface Props {
  endpoint: Endpoint;
  poolsById: ReadonlyMap<string, RpcPool>;
  /** Max chips to render before collapsing into a "+N" overflow chip. */
  max?: number;
  className?: string;
}

/**
 * Single, tone-driven chip cluster for the endpoint row. Replaces the
 * three parallel pill systems that used to co-exist here (archive dot,
 * bespoke eligibility pill, callable badge, kind label) with a uniform
 * hairline `Chip` API — so borders, spacing, casing, and hover states
 * are guaranteed identical across contexts.
 */
export function EndpointChipCluster({ endpoint, poolsById, max = 3, className }: Props) {
  const chips: Array<{ key: string; tone: ChipTone; label: string; title: string }> = [];
  const eli = endpointEligibility(endpoint, poolsById);
  if (eli !== "unassigned") {
    chips.push({
      key: "eli",
      tone: ELIGIBILITY_CHIP_TONE[eli],
      label: ELIGIBILITY_LABEL[eli],
      title: `Pool eligibility · ${ELIGIBILITY_LABEL[eli]}`,
    });
  }
  if (endpoint.archive) {
    chips.push({ key: "archive", tone: "ok", label: "Archive", title: "Archive-capable" });
  }
  const authRequired = Boolean((endpoint as Record<string, unknown>).auth_required);
  if (authRequired) {
    chips.push({ key: "auth", tone: "warn", label: "Auth", title: "Requires auth" });
  }
  if (chips.length === 0) return null;

  const visible = chips.slice(0, max);
  const overflow = chips.length - visible.length;

  return (
    <div className={className ?? "flex flex-wrap items-center gap-1"}>
      {visible.map((c) => (
        <Chip key={c.key} tone={c.tone} title={c.title} className="!text-[10px]">
          {c.label}
        </Chip>
      ))}
      {overflow > 0 ? (
        <Chip tone="muted" title={`${overflow} more`}>
          +{overflow}
        </Chip>
      ) : null}
    </div>
  );
}
