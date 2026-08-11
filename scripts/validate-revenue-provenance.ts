// #10443/#10516: revenue provenance has to be earned by the surface claiming
// it, and a protocol account may never be labelled as somebody's money.
//
// schemas/subnet-manifest.schema.json already blocks a hand-set revenue AMOUNT
// -- the `revenue` block is additionalProperties:false over declaration fields
// only, so `"amount": 4260000` cannot be written at all. That leaves the holes
// a JSON Schema cannot see, because they are relationships between fields
// rather than shapes:
//
//   A. `provenance: probe-derived` on a surface nothing probes. The claim says
//      a value was observed on a schedule; if probe.enabled is false, nothing
//      ever observes it, and the figure can only have come from a human.
//      Same for an auth-gated surface: the prober has no credential, so a
//      probe-derived claim over auth_required is unfounded by construction.
//   B. `operator-attested` with no source_url -- an attestation with nothing
//      to cite is just an assertion.
//   C. An entity carrying a revenue or treasury role over a PROTOCOL-DERIVED
//      subnet account. #10448 nearly recorded SN64's own TAO reserve as a
//      Chutes revenue collector: it receives large, continuous, many-party
//      inbound, because that is what buying alpha looks like, so it presents
//      exactly like a payment collector. Evidence requirements do not catch
//      this -- the citation would be real and the conclusion still wrong.
//
// (C) is the reason this file exists. It is the one failure mode where being
// careful is not enough, because the wrong answer looks right.
import path from "node:path";
import { listJsonFiles, readJson, repoRoot } from "./lib.ts";
import { protocolSubnetNetuid } from "../src/subnet-accounts.ts";

// Registry documents are read for validation only, never trusted for control
// flow. Mirrors the readJson precedent in lib.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** Roles that assert somebody's money moves through an address. */
const MONEY_CATEGORIES = new Set([
  "payment-collector",
  "treasury",
  "burn",
  "multisig",
]);

export interface ProvenanceViolation {
  file: string;
  subject: string;
  message: string;
}

/**
 * Check one subnet manifest's surfaces. Exported for the test, which needs to
 * drive it over crafted documents rather than only over the live registry --
 * a gate asserted solely against a clean registry passes on nothing.
 */
export function checkSurfaceRevenue(
  subnet: Row,
  file = "<memory>",
): ProvenanceViolation[] {
  const out: ProvenanceViolation[] = [];
  for (const surface of Array.isArray(subnet?.surfaces)
    ? subnet.surfaces
    : []) {
    const revenue = surface?.revenue;
    if (!revenue || typeof revenue !== "object") continue;
    const id = String(surface?.id ?? "<unnamed surface>");
    const provenance = revenue.provenance;

    if (provenance === "probe-derived") {
      if (surface?.probe?.enabled !== true) {
        out.push({
          file,
          subject: id,
          message:
            'provenance "probe-derived" but probe.enabled is not true — nothing observes this surface, so the figure cannot have been derived from a probe',
        });
      }
      if (surface?.auth_required === true) {
        out.push({
          file,
          subject: id,
          message:
            'provenance "probe-derived" but auth_required is true — the prober holds no credential for this surface, so use "operator-attested"',
        });
      }
    }

    if (provenance === "operator-attested" && !revenue.source_url) {
      out.push({
        file,
        subject: id,
        message:
          'provenance "operator-attested" with no source_url — an attestation that cites nothing is an assertion',
      });
    }

    // #10566: a headline-eligible figure must be USD.
    //
    // The serving layer sums `amount_usd` against a USD-priced denominator. A
    // TAO-denominated figure is not a cast into that sum -- it needs the
    // tao-usd index at each observation's OWN instant, because a month-old
    // reading priced at today's rate is a different number. ALPHA is worse:
    // paid in the subnet's own token, it is circular by construction and
    // #10439 excludes it from external revenue outright.
    //
    // Refused at declaration rather than filtered at read, so a non-USD surface
    // cannot quietly read back as "not observed" -- which is what a filter
    // alone would produce, and which is indistinguishable from a probe that has
    // not run. All four eligible surfaces are USD today; this keeps the fifth
    // from being summed wrong.
    if (
      revenue.role === "external-revenue" &&
      (provenance === "probe-derived" || provenance === "chain-verified") &&
      revenue.currency !== "USD"
    ) {
      out.push({
        file,
        subject: id,
        message:
          `role "external-revenue" with readable provenance "${provenance}" but currency ` +
          `"${revenue.currency ?? "unset"}" — the coverage ratio sums USD against a ` +
          "USD-priced denominator, and converting needs the tao-usd rate at each " +
          "observation's own instant. Declare the surface operator-attested until that exists.",
      });
    }
  }
  return out;
}

/**
 * #10543: the subnet-level search record must agree with the surfaces.
 *
 * `revenue_search` summarises a search; the surfaces are its result. Nothing
 * links them, so without this the summary quietly rots: a subnet recorded
 * `none-found` in March keeps asserting it after a revenue surface is added in
 * August, and the "N% of the network has no observable external revenue" claim
 * silently overcounts. A summary that cannot disagree with its data is a
 * comment, not a record.
 */
export function checkRevenueSearch(
  subnet: Row,
  file = "<memory>",
): ProvenanceViolation[] {
  const search = subnet?.revenue_search;
  if (!search || typeof search !== "object") return [];
  const declared = (
    Array.isArray(subnet?.surfaces) ? subnet.surfaces : []
  ).filter((s: Row) => s?.revenue?.role === "external-revenue");
  const subject = `netuid ${subnet?.netuid ?? "?"}`;
  if (search.outcome === "none-found" && declared.length > 0) {
    return [
      {
        file,
        subject,
        message:
          `revenue_search says "none-found" but ${declared.length} surface(s) declare ` +
          `role "external-revenue" (${declared.map((s: Row) => s.id).join(", ")}). ` +
          "The search record has gone stale against its own data.",
      },
    ];
  }
  if (search.outcome === "surfaces-declared" && declared.length === 0) {
    return [
      {
        file,
        subject,
        message:
          'revenue_search says "surfaces-declared" but no surface declares role ' +
          '"external-revenue". Either the declaration was removed and the summary was not ' +
          'updated, or the outcome should be "none-found".',
      },
    ];
  }
  return [];
}

/**
 * #10586: the subnet-level WALLET search record must agree with the entities.
 *
 * The exact sibling of checkRevenueSearch, against a different store. A summary
 * that cannot disagree with its data is a comment, not a record -- and this one
 * rots in a direction that matters: "96 of 128 subnets publish no treasury
 * address" is the headline claim the attribution issues exist to earn, and a
 * subnet recorded `none-found` in August keeps asserting it after a treasury is
 * registered in September.
 *
 * `netuidsWithEntities` is passed in rather than read here so the check stays a
 * pure function over two inputs -- the same reason checkSurfaceRevenue takes a
 * document instead of a path.
 */
export function checkWalletSearch(
  subnet: Row,
  netuidsWithEntities: ReadonlySet<number>,
  file = "<memory>",
): ProvenanceViolation[] {
  const search = subnet?.wallet_search;
  if (!search || typeof search !== "object") return [];
  const netuid = Number(subnet?.netuid);
  const declared = Number.isInteger(netuid) && netuidsWithEntities.has(netuid);
  const subject = `netuid ${subnet?.netuid ?? "?"}`;
  if (search.outcome === "none-found" && declared) {
    return [
      {
        file,
        subject,
        message:
          'wallet_search says "none-found" but registry/entities/ registers at least one ' +
          "address against this netuid. The search record has gone stale against its own data.",
      },
    ];
  }
  if (search.outcome === "wallets-declared" && !declared) {
    return [
      {
        file,
        subject,
        message:
          'wallet_search says "wallets-declared" but no entity file carries this netuid. ' +
          "Either the entry was removed and the summary was not updated, or the outcome " +
          'should be "none-found".',
      },
    ];
  }
  return [];
}

/** Check one entity label. Exported for the same reason as above. */
export function checkEntityRole(
  entity: Row,
  file = "<memory>",
): ProvenanceViolation[] {
  const category = entity?.category;
  if (!MONEY_CATEGORIES.has(String(category))) return [];
  const netuid = protocolSubnetNetuid(entity?.ss58);
  if (netuid === null) return [];
  return [
    {
      file,
      subject: String(entity?.ss58 ?? "<no ss58>"),
      message:
        `category "${category}" on the protocol-derived TAO account for netuid ${netuid}. ` +
        "This address is derived by the runtime, not owned by anyone — its inbound is users " +
        "staking, a capital flow, not revenue. See #10448.",
    },
  ];
}

export async function collectViolations(): Promise<ProvenanceViolation[]> {
  const violations: ProvenanceViolation[] = [];

  // Entities first: the wallet-search cross-check needs to know which netuids
  // have a registered address before it can judge a subnet's own summary.
  const entityDir = path.join(repoRoot, "registry/entities");
  const netuidsWithEntities = new Set<number>();
  for (const file of await listJsonFiles(entityDir)) {
    const entity = (await readJson(file)) as Row;
    violations.push(...checkEntityRole(entity, path.relative(repoRoot, file)));
    const netuid = Number(entity?.netuid);
    if (Number.isInteger(netuid)) netuidsWithEntities.add(netuid);
  }

  const subnetDir = path.join(repoRoot, "registry/subnets");
  for (const file of await listJsonFiles(subnetDir)) {
    const subnet = (await readJson(file)) as Row;
    const rel = path.relative(repoRoot, file);
    violations.push(...checkSurfaceRevenue(subnet, rel));
    violations.push(...checkRevenueSearch(subnet, rel));
    violations.push(...checkWalletSearch(subnet, netuidsWithEntities, rel));
  }

  return violations;
}

// Only run the CLI when invoked directly, so the test can import the checks.
if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = await collectViolations();
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}: ${v.subject}\n  ${v.message}`);
    }
    console.error(
      `\nRevenue provenance validation FAILED: ${violations.length} violation(s).`,
    );
    process.exit(1);
  }
  console.log("Revenue provenance validation passed.");
}
