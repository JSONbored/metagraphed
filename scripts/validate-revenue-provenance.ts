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
  }
  return out;
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

  const subnetDir = path.join(repoRoot, "registry/subnets");
  for (const file of await listJsonFiles(subnetDir)) {
    const subnet = (await readJson(file)) as Row;
    violations.push(
      ...checkSurfaceRevenue(subnet, path.relative(repoRoot, file)),
    );
  }

  const entityDir = path.join(repoRoot, "registry/entities");
  for (const file of await listJsonFiles(entityDir)) {
    const entity = (await readJson(file)) as Row;
    violations.push(...checkEntityRole(entity, path.relative(repoRoot, file)));
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
