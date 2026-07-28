import { useQuery } from "@tanstack/react-query";
import { BrandIcon } from "@jsonbored/ui-kit";
import { nametagIndexQuery } from "@/lib/metagraphed/queries";
import { resolveAddress } from "@/lib/metagraphed/resolve-address";
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
  // #8372: layer curated-nametag resolution on top of the identity check this
  // chip already does, via the same precedence ladder AddressDisplay uses
  // (resolveAddress, not AddressDisplay itself -- this chip's callers
  // (validator-columns.tsx, validators-compare-drawer.tsx) always render it
  // inside their own outer Link to the validator page, and AddressDisplay's
  // CopyButton doesn't stop click propagation, so nesting AddressDisplay's
  // own Link/CopyButton here would break that outer navigation. BrandIcon's
  // `name` also needs a plain string, another reason this stays non-JSX).
  const { data: nametags } = useQuery(nametagIndexQuery());
  const identityName = identity?.has_identity ? identity.name : undefined;
  const nametag = nametags?.get(hotkey) ?? null;
  const name = resolveAddress(hotkey, { identityName, nametag }).display;

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
        <span className="truncate font-medium text-ink-strong mg-type-caption" title={name}>
          {name}
        </span>
      ) : null}
    </span>
  );
}
