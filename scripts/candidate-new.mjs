import path from "node:path";
import {
  loadCandidates,
  loadNativeSnapshot,
  loadProviders,
  loadSubnets,
  normalizePublicUrl,
  repoRoot,
  slugify,
  stableStringify,
  writeJson,
} from "./lib.mjs";
import {
  buildPrSubmissionReport,
  normalizeGitHubLogin,
} from "./submission-policy.mjs";

const args = process.argv.slice(2);
const write = args.includes("--write");
const netuid = Number(valueAfter("--netuid"));
const kind = valueAfter("--kind");
const url = normalizePublicUrl(valueAfter("--url"));
const sourceUrl = normalizePublicUrl(valueAfter("--source-url"));
const provider = slugify(valueAfter("--provider") || "community");
const submittedBy = normalizeGitHubLogin(
  valueAfter("--submitted-by") || process.env.GITHUB_ACTOR || process.env.USER,
);
const name = valueAfter("--name");
const authRequired = parseBoolean(valueAfter("--auth-required") || "false");
const rateLimitNotes = valueAfter("--rate-limit-notes") || "";
const outArg = valueAfter("--out");

const native = await loadNativeSnapshot();
const subnet = native.subnets.find((candidate) => candidate.netuid === netuid);

if (!subnet) {
  fail("--netuid must be an active Finney netuid");
}
if (!kind) {
  fail("--kind is required");
}
if (!url) {
  fail("--url must be a public http(s), wss, or ws URL");
}
if (!sourceUrl) {
  fail("--source-url must be a public http(s), wss, or ws URL");
}
if (!submittedBy) {
  fail("--submitted-by or GITHUB_ACTOR is required");
}
if (authRequired === null) {
  fail("--auth-required must be true or false");
}

const host = new URL(url).hostname;
const id = `community-sn-${netuid}-${kind}-${slugify(host)}`;
const outPath =
  outArg || path.join(repoRoot, "registry/candidates/community", `${id}.json`);
const outputPath = path.resolve(outPath);
const document = {
  schema_version: 1,
  submission: {
    submitted_by: submittedBy,
    submitted_by_url: `https://github.com/${submittedBy}`,
  },
  candidates: [
    {
      schema_version: 1,
      id,
      netuid,
      state: "schema-valid",
      name: name || `${subnet.name} community ${kind}`,
      kind,
      url,
      source_url: sourceUrl,
      source_urls: [sourceUrl],
      source_type: "community-pr-intake",
      source_tier: "community-docs",
      confidence: "medium",
      provider,
      auth_required: authRequired,
      public_safe: true,
      rate_limit_notes: rateLimitNotes,
      review_notes: "Community-submitted public interface candidate.",
    },
  ],
};

const report = buildPrSubmissionReport({
  changedFiles: [path.relative(repoRoot, outputPath)],
  candidateDocument: document,
  submitter: submittedBy,
  native,
  providers: await loadProviders(),
  existingCandidates: await loadCandidates(),
  existingSubnets: await loadSubnets(),
});

if (report.blocking) {
  console.error(stableStringify(report));
  process.exit(1);
}

if (write) {
  await writeJson(outputPath, document);
}

console.log(
  stableStringify({
    mode: write ? "write" : "dry-run",
    output_path: path.relative(repoRoot, outputPath),
    public_state: report.public_state,
    next_action: report.next_action,
    manual_reasons: report.manual_reasons,
    warnings: report.warnings,
    candidate: document.candidates[0],
  }),
);

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] || null;
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
