// Append a community surface to a subnet's single file
// (registry/subnets/<slug>.json → surfaces[]) — the single-file contribution
// model that replaces the per-candidate-file lane (registry/candidates/community).
// The surface lands with authority:"community" + review.state:"community-submitted";
// the Gittensory Gate / maintainer review promotes it in place, and the build's
// prober owns verification/health. See .claude/skills/metagraphed.
//
//   npm run surface:add -- --netuid 7 --kind docs \
//     --url https://docs.example.com \
//     --source-url https://github.com/example/project \
//     --provider <provider-slug> --submitted-by <github-login> --write
//
// Debut provider (slug not registered yet)? Add --provider-name "<Team>" and
// --provider-url <https://public-site> and surface:add also scaffolds
// registry/providers/<slug>.json so the PR validates in one shot.
import path from "node:path";
import {
  isJsonContentType,
  isUnsafeResolvedUrl,
  listJsonFiles,
  loadNativeSnapshot,
  loadProviders,
  normalizePublicUrl,
  readJson,
  repoRoot,
  safeFetch,
  slugify,
  stableStringify,
  subnetSurfaceKey,
  writeRepositoryJson,
} from "./lib.mjs";
import { normalizeGitHubLogin } from "./registry-identity.mjs";

const args = process.argv.slice(2);
const write = args.includes("--write");
// Live verification is ON by default — it probes the real URLs so a contributor
// finds out NOW (not after a closed PR) that a surface is dead/private, and it
// fills openapi schema fields from the live spec. --skip-verify for offline work.
const skipVerify = args.includes("--skip-verify");
const netuid = Number(valueAfter("--netuid"));
const kind = valueAfter("--kind");
const url = normalizePublicUrl(valueAfter("--url"));
const sourceUrls = valuesAfter("--source-url")
  .concat((valueAfter("--source-urls") || "").split(",").filter(Boolean))
  .map((value) => normalizePublicUrl(value))
  .filter(Boolean);
const provider = slugify(valueAfter("--provider") || "community");
const submittedBy = normalizeGitHubLogin(
  valueAfter("--submitted-by") || process.env.GITHUB_ACTOR || process.env.USER,
);
const name = valueAfter("--name");
const authRequired = parseBoolean(valueAfter("--auth-required") || "false");
const rateLimitNotes = valueAfter("--rate-limit-notes") || "";
const notes = valueAfter("--notes") || "";
// Debut-provider auto-scaffold inputs (only used when --provider isn't registered).
const providerName = valueAfter("--provider-name");
const providerUrl = normalizePublicUrl(valueAfter("--provider-url"));
const providerKind = valueAfter("--provider-kind") || "subnet-team";
const providerGithub = valueAfter("--provider-github")
  ? normalizePublicUrl(valueAfter("--provider-github"))
  : null;

const native = await loadNativeSnapshot();
const subnet = native.subnets.find((entry) => entry.netuid === netuid);

if (!subnet) fail("--netuid must be an active Finney netuid");
if (!kind) fail("--kind is required");
if (!url) fail("--url must be a public http(s), wss, or ws URL");
if (sourceUrls.length === 0)
  fail("--source-url (a public URL that proves the claim) is required");
if (!submittedBy) fail("--submitted-by or GITHUB_ACTOR is required");
if (authRequired === null) fail("--auth-required must be true or false");

const { filePath, document } = await resolveSubnetFile(netuid);
if (!document) {
  fail(
    `No registry/subnets file for netuid ${netuid}. Scaffold it first:\n` +
      `  npm run subnet:new -- --netuid ${netuid} --write`,
  );
}

// Provider must be a registered slug to pass validate:surface + CI. For a debut
// provider, auto-scaffold a flat registry/providers/<slug>.json stub in the same
// PR so the contributor never hits the unregistered-provider failure. Providers
// are flat objects (trust is the `authority` field, not the directory — #1678).
// The website_url is only stored (never fetched), so normalizePublicUrl's
// synchronous safety check (it rejects localhost/private hosts) is sufficient.
const providerIds = new Set((await loadProviders()).map((entry) => entry.id));
const providerFilePath = path.join(
  repoRoot,
  "registry/providers",
  `${provider}.json`,
);
let providerStub = null;
if (!providerIds.has(provider)) {
  if (!providerName || !providerUrl) {
    fail(
      `Provider "${provider}" is not registered. Add --provider-name "<Team Name>" ` +
        "and --provider-url <https://public-site> so surface:add scaffolds " +
        `registry/providers/${provider}.json in the same PR, ` +
        "or pick an existing slug with `npm run providers:list`.",
    );
  }
  providerStub = {
    schema_version: 1,
    id: provider,
    name: providerName,
    kind: providerKind,
    website_url: providerUrl,
    ...(providerGithub ? { github_url: providerGithub } : {}),
    authority: "community",
    public_notes: "",
  };
}

const surfaces = Array.isArray(document.surfaces) ? document.surfaces : [];
// Key both sides under this netuid so a true duplicate is actually caught.
const newKey = subnetSurfaceKey({ kind, url }, netuid);
if (surfaces.some((surface) => subnetSurfaceKey(surface, netuid) === newKey)) {
  fail(
    `That surface already exists on ${document.slug || subnet.name} ` +
      `(${kind} ${url}). One subnet = one file; don't re-add a duplicate.`,
  );
}

const id = uniqueSurfaceId(surfaces, netuid, provider, kind, url);
const surface = {
  id,
  name: name || `${subnet.name} ${kind}`,
  kind,
  url,
  provider,
  authority: "community",
  auth_required: authRequired,
  public_safe: true,
  source_urls: [...new Set(sourceUrls)],
  review: { state: "community-submitted", submitted_by: submittedBy },
  ...(rateLimitNotes ? { rate_limit_notes: rateLimitNotes } : {}),
  ...(notes ? { notes } : {}),
};

const findings = skipVerify
  ? ["skipped (--skip-verify)"]
  : await verifyAndEnrich(surface);

document.surfaces = [...surfaces, surface];

if (write) {
  await writeRepositoryJson(filePath, document);
  if (providerStub) {
    await writeRepositoryJson(providerFilePath, providerStub);
  }
}

console.log(
  stableStringify({
    mode: write ? "write" : "dry-run",
    subnet_file: path.relative(repoRoot, filePath),
    surface_count: document.surfaces.length,
    verification: findings,
    surface,
    ...(providerStub
      ? {
          provider_stub: {
            file: path.relative(repoRoot, providerFilePath),
            provider: providerStub,
          },
        }
      : {}),
    next: providerStub
      ? "Debut provider scaffolded — open a PR with BOTH this subnet file and the new registry/providers file. Link a tracked issue (Closes #N)."
      : "Link a tracked issue (Closes #N) and open a PR that changes ONLY this file.",
  }),
);

// Live verification with real information: hard-fail on a private/unsafe URL (so
// public_safe:true is never a lie), warn on anything not reachable right now, and
// for openapi auto-discover the spec → set schema_url/schema_status + name from
// the live title (closing the gap where a hand-added openapi surface had no schema
// fields and failed CI). Network-dependent; --skip-verify bypasses it offline.
async function verifyAndEnrich(target) {
  const checks = [
    ["url", target.url],
    ...target.source_urls.map((value) => ["source_url", value]),
  ];
  for (const [label, value] of checks) {
    if (await isUnsafeResolvedUrl(value)) {
      fail(
        `${label} resolves to a private/unsafe address and cannot be a public surface: ${value}`,
      );
    }
  }
  const out = [];
  const urlProbe = await probeUrl(target.url);
  if (!urlProbe.ok) {
    out.push(
      `WARN url not reachable right now (${urlProbe.detail}) — confirm it is public + live before merging.`,
    );
  }
  for (const value of target.source_urls) {
    const probe = await probeUrl(value);
    if (!probe.ok) {
      out.push(
        `WARN source_url not reachable right now (${probe.detail}): ${value} — it must independently prove the claim.`,
      );
    }
  }
  if (target.kind === "openapi") {
    const spec = await fetchOpenApi(target.url);
    if (spec) {
      target.schema_url = spec.schemaUrl;
      target.schema_status = "machine-readable";
      if (!name && spec.document.info?.title) {
        target.name = `${subnet.name} ${spec.document.info.title}`;
      }
      const paths = spec.document.paths
        ? Object.keys(spec.document.paths).length
        : 0;
      out.push(
        `OK openapi spec verified (${spec.document.info?.title || "untitled"}, ${paths} paths) → schema_url + schema_status set.`,
      );
    } else {
      out.push(
        `WARN openapi: no machine-readable OpenAPI/Swagger JSON found at ${target.url}. CI's full validate REQUIRES schema_status:"machine-readable" — point --url at the spec (e.g. .../openapi.json) or use a different --kind.`,
      );
    }
  }
  if (out.length === 0) out.push("OK reachable + public-safe.");
  return out;
}

async function probeUrl(target) {
  // safeFetch re-checks every redirect hop, so a public host can't redirect into
  // a private address to defeat the public-safe guard.
  const result = await safeFetch(target, { accept: "*/*" });
  if (result.unsafe) {
    return { ok: false, detail: "redirects to a private/unsafe address" };
  }
  if (result.error) return { ok: false, detail: result.error };
  await result.response?.body?.cancel();
  return result.ok
    ? { ok: true }
    : { ok: false, detail: `HTTP ${result.status}` };
}

async function fetchOpenApi(target) {
  const candidates = [target];
  try {
    const parsed = new URL(target);
    for (const suffix of [
      "/openapi.json",
      "/swagger.json",
      "/api-json",
      "/docs-json",
    ]) {
      candidates.push(`${parsed.origin}${suffix}`);
    }
  } catch {
    // invalid URL — validation elsewhere reports it
  }
  for (const candidate of [...new Set(candidates)]) {
    const result = await safeFetch(candidate, { accept: "application/json" });
    if (
      !result.ok ||
      !result.response ||
      !isJsonContentType(result.response.headers.get("content-type"))
    ) {
      await result.response?.body?.cancel();
      continue;
    }
    try {
      const document = JSON.parse(await result.response.text());
      const looksOpenApi =
        document &&
        typeof document === "object" &&
        (typeof document.openapi === "string" ||
          typeof document.swagger === "string" ||
          Boolean(document.paths));
      // result.url is the final URL after safe redirects — the real spec location.
      if (looksOpenApi) return { document, schemaUrl: result.url };
    } catch {
      // not JSON / not a spec — try the next candidate
    }
  }
  return null;
}

async function resolveSubnetFile(targetNetuid) {
  const files = await listJsonFiles(path.join(repoRoot, "registry/subnets"));
  for (const file of files) {
    const doc = await readJson(file);
    if (doc?.netuid === targetNetuid) return { filePath: file, document: doc };
  }
  return { filePath: null, document: null };
}

function uniqueSurfaceId(existing, uid, prov, srfKind, srfUrl) {
  const ids = new Set(existing.map((surface) => surface.id));
  const base = `sn-${uid}-${prov}-${srfKind}`;
  if (!ids.has(base)) return base;
  const host = slugify(hostnameOf(srfUrl));
  const withHost = host ? `${base}-${host}` : base;
  if (!ids.has(withHost)) return withHost;
  let counter = 2;
  while (ids.has(`${withHost}-${counter}`)) counter += 1;
  return `${withHost}-${counter}`;
}

function hostnameOf(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] || null;
}

function valuesAfter(flag) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function parseBoolean(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (["true", "yes", "1"].includes(normalized)) return true;
  if (["false", "no", "0"].includes(normalized)) return false;
  return null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
