// Fails if the registry stops matching SUBNET_SLOT_CAP (#11320).
//
// /subnets states its count in the <title> and the on-page intro from a
// constant rather than a per-request fetch, because the count is capped by the
// protocol: a registration changes which project occupies a netuid, not how
// many netuids exist. That is a sound optimisation exactly as long as the cap
// holds, and Bittensor governance has discussed raising it.
//
// So the constant needs a tripwire. Without one, a raised cap means a wrong
// number in a page title and a search result -- the slowest possible way to
// find out, and one nobody would think to check.
//
// Deliberately LOCAL: it reads registry/subnets/, not /api/v1/coverage. A
// validator that depends on the network can fail for reasons that have nothing
// to do with the property under test, and this one must be able to run in a
// fork's CI with no credentials.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ROOT_NETUID,
  SUBNET_SLOT_CAP,
} from "../apps/ui/src/lib/metagraphed/bittensor.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const subnetsDir = path.join(repoRoot, "registry/subnets");

function registryNetuids(): number[] {
  return fs
    .readdirSync(subnetsDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const raw = fs.readFileSync(path.join(subnetsDir, file), "utf8");
      const netuid = (JSON.parse(raw) as { netuid?: unknown }).netuid;
      if (typeof netuid !== "number") {
        throw new Error(`registry/subnets/${file} has no numeric netuid`);
      }
      return netuid;
    })
    .sort((a, b) => a - b);
}

const netuids = registryNetuids();
const application = netuids.filter((netuid) => netuid !== ROOT_NETUID);
const problems: string[] = [];

if (application.length !== SUBNET_SLOT_CAP) {
  problems.push(
    `registry holds ${application.length} application subnets, SUBNET_SLOT_CAP says ${SUBNET_SLOT_CAP}.\n` +
      `  If the protocol cap moved, update SUBNET_SLOT_CAP in apps/ui/src/lib/metagraphed/bittensor.ts.\n` +
      `  Every page title and intro stating the count reads from it.`,
  );
}

// A gap means the registry is incomplete, which would make the stated count
// right and the page's own list short -- the disagreement the constant exists
// to prevent. Checked separately from the total so the message names the cause.
const missing = Array.from({ length: SUBNET_SLOT_CAP }, (_, i) => i + 1).filter(
  (netuid) => !netuids.includes(netuid),
);
if (missing.length > 0) {
  problems.push(`registry is missing netuid(s): ${missing.join(", ")}`);
}

if (!netuids.includes(ROOT_NETUID)) {
  problems.push(`registry has no root subnet (netuid ${ROOT_NETUID})`);
}

if (problems.length > 0) {
  console.error("validate:subnet-slot-cap FAILED\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `validate:subnet-slot-cap passed — ${application.length} application subnets ` +
    `(netuid 1..${SUBNET_SLOT_CAP}) plus root, matching SUBNET_SLOT_CAP.`,
);
