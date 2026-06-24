// Scaffold a new per-subnet registry file (registry/subnets/<name-slug>.json) for
// a subnet that doesn't have one yet, so a contributor can add surfaces to it with
// `npm run surface:add`. One file per subnet is the single-file contribution model.
//
//   npm run subnet:new -- --netuid 123 --write
import path from "node:path";
import {
  classifyNativeName,
  listJsonFiles,
  loadNativeSnapshot,
  readJson,
  repoRoot,
  slugify,
  stableStringify,
  writeRepositoryJson,
} from "./lib.mjs";

const args = process.argv.slice(2);
const write = args.includes("--write");
const netuid = Number(valueAfter("--netuid"));

const native = await loadNativeSnapshot();
const subnet = native.subnets.find((entry) => entry.netuid === netuid);
if (!subnet) fail("--netuid must be an active Finney netuid");

const subnetsDir = path.join(repoRoot, "registry/subnets");
const files = await listJsonFiles(subnetsDir);
for (const file of files) {
  const doc = await readJson(file);
  if (doc?.netuid === netuid) {
    fail(
      `Subnet ${netuid} already has a file: ${path.relative(repoRoot, file)}. ` +
        `Add surfaces to it with \`npm run surface:add -- --netuid ${netuid} ...\`.`,
    );
  }
}

// Never adopt a placeholder on-chain identity (e.g. "Team TBC") as the registry
// display name — require a real --name when the chain identity isn't usable.
const nameArg = valueAfter("--name");
const name =
  nameArg ||
  (classifyNativeName(subnet.name, netuid).quality === "chain"
    ? subnet.name
    : null);
if (!name) {
  fail(
    `SN${netuid}'s on-chain identity (${JSON.stringify(subnet.name || null)}) is a placeholder, not a real name. ` +
      `Pass --name "<real subnet name>" (check taostats or the subnet's source repo).`,
  );
}
if (classifyNativeName(name, netuid).quality !== "chain") {
  fail(
    `--name ${JSON.stringify(name)} looks like a placeholder — provide the subnet's real display name.`,
  );
}

const fileSlug = slugify(name) || `sn-${netuid}`;
const filePath = path.join(subnetsDir, `${fileSlug}.json`);
const document = {
  schema_version: 1,
  netuid,
  name,
  slug: `sn-${netuid}`,
  status: subnet.status === "inactive" ? "inactive" : "active",
  categories: [],
  curation: { level: "candidate-discovered", review_state: "unreviewed" },
  surfaces: [],
};

if (write) {
  await writeRepositoryJson(filePath, document);
}

console.log(
  stableStringify({
    mode: write ? "write" : "dry-run",
    subnet_file: path.relative(repoRoot, filePath),
    document,
    next: `Add a surface: npm run surface:add -- --netuid ${netuid} --kind ... --url ... --source-url ... --provider ... --submitted-by ... --write`,
  }),
);

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] || null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
