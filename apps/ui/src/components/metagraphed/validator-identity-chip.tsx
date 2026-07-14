import { BrandIcon } from "@jsonbored/ui-kit";
import { shortHash } from "@/lib/metagraphed/blocks";
import type { ColdkeyIdentity } from "@/lib/metagraphed/types";

/** Operator identity chip — coldkey's self-declared name/logo (#5234), not hotkey-specific. */
export function ValidatorIdentityChip({
  hotkey,
  identity,
  size = 28,
  showName = true,
}: {
  hotkey: string;
  identity: ColdkeyIdentity | null | undefined;
  size?: number;
  showName?: boolean;
}) {
  const name =
    identity?.has_identity && identity.name ? identity.name : (shortHash(hotkey) ?? hotkey);

  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <BrandIcon
        iconUrl={identity?.image}
        url={identity?.url}
        repoUrl={identity?.github}
        name={name}
        fallback={hotkey}
        size={size}
      />
      {showName ? (
        <span className="truncate font-medium text-ink-strong text-[12px]" title={name}>
          {name}
        </span>
      ) : null}
    </span>
  );
}
