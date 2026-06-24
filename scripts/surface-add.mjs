// Append a community surface to a subnet's single file
// (registry/subnets/<slug>.json → surfaces[]) — the single-file contribution
// model that replaces the per-candidate-file lane (registry/candidates/community).
// The surface lands with authority:"community" + review.state:"community-submitted";
// the Gittensory Gate / maintainer review promotes it in place, and the build's
// prober owns verification/health. See .claude/skills/contributing-to-metagraphed.
//
//   npm run surface:add -- --netuid 7 --kind docs \
//     --url https://docs.example.com \
//     --source-url https://github.com/example/project \
//     --provider <provider-slug> --submitted-by <github-login> --write
import path from "node:path";
import {
  isJsonContentType,
  isUnsafeResolvedUrl,
  listJsonFiles,
  loadNativeSnapshot,
  loadProviders,
  normalizePublicUrl,
  readJson,
  registrySurfaceKey,
  repoRoot,
  slugify,
  stableStringify,
  writeRepositoryJson,
} from "./lib.mjs";
import { normalizeGitHubLogin } from "./submission-policy.mjs";

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

// Provider must be a registered slug to pass validate:surface + CI. Warn (don't
// fail) so a debut provider added in the same PR still works.
const providerIds = new Set((await loadProviders()).map((entry) => entry.id));
if (!providerIds.has(provider)) {
  console.warn(
    `Warning: provider "${provider}" is not a registered slug, so this surface will ` +
      "FAIL `npm run validate:surface` and CI. Pick one with `npm run providers:list`, " +
      "or register it with `npm run provider:new` in the same PR.",
  );
}

const surfaces = Array.isArray(document.surfaces) ? document.surfaces : [];
const newKey = registrySurfaceKey({ netuid, kind, url });
if (surfaces.some((surface) => registrySurfaceKey(surface) === newKey)) {
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
}

console.log(
  stableStringify({
    mode: write ? "write" : "dry-run",
    subnet_file: path.relative(repoRoot, filePath),
    surface_count: document.surfaces.length,
    verification: findings,
    surface,
    next: "Link a tracked issue (Closes #N) and open a PR that changes ONLY this file.",
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(target, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "metagraphed-surface-add/0.0", accept: "*/*" },
    });
    await response.body?.cancel();
    return response.ok
      ? { ok: true }
      : { ok: false, detail: `HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      detail: error.name === "AbortError" ? "timeout" : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(candidate, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": "metagraphed-surface-add/0.0",
          accept: "application/json",
        },
      });
      if (
        !response.ok ||
        !isJsonContentType(response.headers.get("content-type"))
      ) {
        await response.body?.cancel();
        continue;
      }
      const document = JSON.parse(await response.text());
      const looksOpenApi =
        document &&
        typeof document === "object" &&
        (typeof document.openapi === "string" ||
          typeof document.swagger === "string" ||
          Boolean(document.paths));
      if (looksOpenApi) return { document, schemaUrl: candidate };
    } catch {
      // try the next candidate
    } finally {
      clearTimeout(timer);
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
