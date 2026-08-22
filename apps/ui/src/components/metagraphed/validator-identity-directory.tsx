import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { BrandIcon, RankedRailList, type RankedRailItem } from "@jsonbored/ui-kit";
import { validatorsQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import {
  buildValidatorIdentityIndex,
  formatRatePercentRange,
  type ValidatorIdentity,
} from "@/lib/metagraphed/validator-identities";

/** Matches the directory's own ceiling so both views read one cache entry. */
const ALL_VALIDATORS_LIMIT = 2000;

/**
 * The operator directory.
 *
 * Ranks the 148 named identities rather than the 1,022 hotkeys behind them.
 * An operator runs one key per subnet — Yuma has 86 keys across 86 subnets —
 * so a flat hotkey list scattered every operator across dozens of rows and
 * made "who should I delegate to" harder, not easier. Expanding a row shows
 * that operator's keys, each still linking to its own page (#11522).
 */
export function ValidatorIdentityDirectory({ query = "" }: { query?: string }) {
  const { data } = useSuspenseQuery(
    validatorsQuery({ sort: "total_stake", limit: ALL_VALIDATORS_LIMIT, subnets: false }),
  );

  const index = useMemo(
    () => buildValidatorIdentityIndex(data.data.validators ?? []),
    [data.data.validators],
  );

  const needle = query.trim().toLowerCase();
  const identities = useMemo(
    () =>
      needle
        ? index.identities.filter((identity) => identity.name.toLowerCase().includes(needle))
        : index.identities,
    [index.identities, needle],
  );

  const items: RankedRailItem[] = identities.map((identity) => ({
    id: identity.name,
    label: identity.name,
    value: identity.totalStakeTao,
    valueLabel: formatTao(identity.totalStakeTao),
    media: identity.image ? (
      <BrandIcon
        url={identity.url ?? undefined}
        iconUrl={identity.image}
        name={identity.name}
        fallback={identity.name.slice(0, 2)}
        size={22}
      />
    ) : undefined,
    meta: identityMeta(identity),
    detail: <IdentityKeys identity={identity} />,
  }));

  return (
    <div className="mg-validator-identities">
      <RankedRailList
        ariaLabel="Named validator operators ranked by total stake"
        items={items}
        emptyLabel={
          needle
            ? `No named operator matches “${query.trim()}”.`
            : "No named operators are being reported right now."
        }
      />
      <p className="mg-validator-identities-note">
        {formatNumber(index.identities.length)} named operators hold{" "}
        {(index.namedStakeShare * 100).toFixed(1)}% of observed stake.{" "}
        {formatNumber(index.unnamed.length)} keys declare no identity and are listed individually
        under Research.
      </p>
    </div>
  );
}

/**
 * The supporting line.
 *
 * Take is a range because an operator's keys genuinely differ — Yuma runs both
 * 9% and 18%, so one blended number would be a rate nobody is charged. Hotkeys
 * appear only when they differ from positions, which is the uncommon case of a
 * key serving several subnets.
 */
function identityMeta(identity: ValidatorIdentity): string {
  const parts = [
    `${formatNumber(identity.subnetPositions)} subnet position${identity.subnetPositions === 1 ? "" : "s"}`,
  ];
  if (identity.hotkeyCount !== identity.subnetPositions) {
    parts.push(`${formatNumber(identity.hotkeyCount)} key${identity.hotkeyCount === 1 ? "" : "s"}`);
  }
  const take = formatRatePercentRange(identity.takeRange);
  if (take) parts.push(`take ${take}`);
  return parts.join(" · ");
}

/**
 * An operator's keys, largest stake first. Each is still its own record, and
 * each stays in the server-rendered DOM so every validator page keeps an
 * inbound link (#11231).
 *
 * Every cell is ONE precomputed string rather than adjacent JSX expressions.
 * React separates adjacent interpolations with a `<!-- -->` marker, and at 590
 * links those markers alone were ~30 KiB of the document — the difference
 * between this list fitting under the payload ratchet and not.
 */
function IdentityKeys({ identity }: { identity: ValidatorIdentity }) {
  return (
    <ul className="mg-validator-keys">
      {identity.members.map((member) => {
        const subnets = member.subnet_count ?? 0;
        const meta =
          `${formatNumber(subnets)} subnet${subnets === 1 ? "" : "s"}` +
          (typeof member.take === "number" ? ` · take ${(member.take * 100).toFixed(1)}%` : "");
        return (
          <li key={member.hotkey}>
            <Link
              to="/validators/$hotkey"
              params={{ hotkey: member.hotkey }}
              className="mg-validator-key"
            >
              {/* Three spans in a fixed order, styled positionally. Class
                  attributes on each cost ~60 bytes a row, and at 590 rows that
                  is 35 KiB of the document for information the order already
                  carries. The focus ring is a CSS rule for the same reason. */}
              <span>{`${member.hotkey.slice(0, 6)}…${member.hotkey.slice(-4)}`}</span>
              <span>{meta}</span>
              <span>{formatTao(member.total_stake_tao ?? 0)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
