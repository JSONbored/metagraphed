import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import { CopyButton, Chip } from "@jsonbored/ui-kit";
import { EntityHoverCard } from "./entity-hover-card";
import { AddressLabelEditor } from "./address-label-editor";
import { isValidSs58 } from "@/lib/metagraphed/accounts";
import { nametagIndexQuery } from "@/lib/metagraphed/queries";
import { resolveAddress } from "@/lib/metagraphed/resolve-address";
import { useAddressLabels } from "@/lib/metagraphed/address-labels";
import { classNames } from "@/lib/metagraphed/format";

/**
 * #8372: the one place an ss58 address turns into something a human can read.
 *
 * Before this, ~55 call sites across ~32 files each called `shortHash(addr)`
 * inline, so an address rendered as `5Grwva…GKutQY` everywhere except the two
 * pages that happened to special-case on-chain identity. This resolves
 * through the shared `resolveAddress` ladder instead -- private label (#8484)
 * -> on-chain identity -> curated nametag -> truncated ss58 -- so improving
 * address rendering is one edit, not fifty-five.
 *
 * #8484: the private label itself is looked up and applied on EVERY render
 * site (dense tables included) since it takes top precedence -- a user who
 * named their own key should see that name everywhere it appears, not just
 * in detail contexts. Only the EDIT affordance (`editable` prop) is reserved
 * for detail contexts; see that prop's own doc comment.
 *
 * The raw ss58 always stays one copy-click away, whatever the display name
 * resolved to: a readable label is an aid, never a replacement for the value
 * a user needs to verify or paste elsewhere.
 *
 * Supersedes AccountAddress (which this keeps API-compatible with, so the
 * sweep is a rename at each call site rather than a rewrite).
 */
export function AddressDisplay({
  ss58,
  fallback,
  keep,
  identityName,
  showCategory = false,
  copyButtonClassName,
  compact,
  truncate = true,
  valueClassName,
  linkToAccount = true,
  preload,
  editable = false,
}: {
  ss58?: string | null;
  fallback: ReactNode;
  /** Chars kept at each end when it falls through to the truncated form. */
  keep?: number;
  /** Forwarded to the internal Link — pass "intent" for a row/list where
   * hover-prefetching the account page is worth the request (matches
   * TanStack Router's own Link prop; omit for dense tables where prefetching
   * every hovered row would be wasteful). */
  preload?: "intent" | "render" | "viewport" | false;
  /**
   * The account's own on-chain identity name, when the CALLER already has it
   * loaded (validator rows, the account masthead). Not fetched here: this
   * component renders inside dense tables, and a per-address identity query
   * would be exactly the N+1 the shared nametag index exists to avoid.
   */
  identityName?: string | null;
  /**
   * Render the nametag's category as a chip alongside the name. On in dense
   * rows would be noise -- reserve it for detail contexts (#8372 req 3).
   */
  showCategory?: boolean;
  /** Render the whole ss58 instead of the ellipsis form. */
  truncate?: boolean;
  copyButtonClassName?: string;
  /** Forwarded to the inner CopyButton — pass true inside a dense row. */
  compact?: boolean;
  valueClassName?: string;
  /** Set false where the surrounding row already links elsewhere. */
  linkToAccount?: boolean;
  /**
   * Render the inline private-label edit affordance (#8484 requirement 3b).
   * Reserve for detail contexts (account masthead, extrinsic signer/target
   * fields, transfer detail rows) — a dense table row rendering it on every
   * line would be noise, the same reasoning `showCategory` already applies.
   */
  editable?: boolean;
}) {
  // Shared across every AddressDisplay on the page -- react-query dedupes to
  // one request, and a failure resolves to an empty index rather than
  // breaking the address (a missing nametag is a display downgrade to the
  // truncated form, never an error state).
  const { data: nametags } = useQuery(nametagIndexQuery());
  // #8484: private labels are a synchronous localStorage read (via
  // useAddressLabels' own effect-populated state), not a query -- applied
  // on every render site regardless of `editable`, see this component's own
  // header comment.
  const { getLabel } = useAddressLabels();

  if (!ss58 || !isValidSs58(ss58)) return <>{fallback}</>;

  const nametag = nametags?.get(ss58) ?? null;
  const localLabel = getLabel(ss58)?.name ?? null;
  const resolved = resolveAddress(ss58, { localLabel, identityName, nametag, keep });
  // `truncate={false}` asks for the raw value, but only when nothing better
  // resolved -- a caller wanting the full address still wants "Binance" over
  // 48 characters of base58 when we know that's what it is.
  const text = resolved.source === "truncated" && !truncate ? ss58 : resolved.display;
  // On the `<a>` itself (not a nested span) -- matches AccountAddress's
  // original structure. Found by adversarial review against a real CI
  // failure: a wrapping-span version put `valueClassName` (e.g.
  // "truncate min-w-0") one DOM level below the actual flex item, so an
  // untruncated `<a>` forced the row wider than its flex parent at narrow
  // viewports instead of ellipsizing -- caught by
  // tests/e2e/responsive-overflow.spec.ts on the extrinsic detail page's
  // Signer field.
  // #8484: private-label text carries the same `ph-no-capture` marker the
  // one-time secret-reveal panels use -- see address-label-editor.tsx's own
  // header comment on why element-level exclusion is needed here (this text
  // renders on routes analytics.ts's route-level replay blocklist doesn't
  // cover, e.g. account/transfer pages).
  const isPrivate = resolved.source === "private";
  const textClassName = classNames(
    "hover:underline",
    isPrivate ? "ph-no-capture" : "",
    valueClassName,
  );

  return (
    <span className="inline-flex items-center gap-1 min-w-0">
      <EntityHoverCard kind="account" ss58={ss58}>
        {linkToAccount ? (
          <Link
            to="/accounts/$ss58"
            params={{ ss58 }}
            title={ss58}
            preload={preload}
            className={textClassName}
          >
            {text}
          </Link>
        ) : (
          <span className={textClassName} title={ss58}>
            {text}
          </span>
        )}
      </EntityHoverCard>
      {isPrivate ? (
        // #8484 requirement 4: visibly distinct from the curated-nametag
        // category chip below, so a private note is never mistaken for a
        // globally-verified claim.
        <span
          className="inline-flex shrink-0 items-center text-accent"
          title="Your private label — visible only to you"
        >
          <UserRound className="size-3" aria-hidden="true" />
        </span>
      ) : null}
      {showCategory && resolved.category ? (
        <Chip tone="muted" title={`Curated nametag · ${resolved.category}`}>
          {resolved.category}
        </Chip>
      ) : null}
      {editable ? <AddressLabelEditor ss58={ss58} /> : null}
      <CopyButton value={ss58} label="account" className={copyButtonClassName} compact={compact} />
    </span>
  );
}
