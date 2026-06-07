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
const id = slugify(valueAfter("--id") || valueAfter("--slug") || "");
const name = valueAfter("--name");
const kind = valueAfter("--kind");
const websiteUrl = normalizePublicUrl(valueAfter("--website-url"));
const docsUrl = normalizeOptionalUrl(valueAfter("--docs-url"));
const githubUrl = normalizeOptionalUrl(valueAfter("--github-url"));
const teamUrl = normalizeOptionalUrl(valueAfter("--team-url"));
const contactUrl = normalizeOptionalUrl(valueAfter("--contact-url"));
const publicNotes = valueAfter("--public-notes") || "";
const authority = valueAfter("--authority") || "community";
const submittedBy = normalizeGitHubLogin(
  valueAfter("--submitted-by") || process.env.GITHUB_ACTOR || process.env.USER,
);
const outArg = valueAfter("--out");

if (!id) {
  fail("--id or --slug is required");
}
if (!name) {
  fail("--name is required");
}
if (!kind) {
  fail("--kind is required");
}
if (!websiteUrl) {
  fail("--website-url must be a public http(s), wss, or ws URL");
}
if (!submittedBy) {
  fail("--submitted-by or GITHUB_ACTOR is required");
}
for (const [flag, value] of [
  ["--docs-url", docsUrl],
  ["--github-url", githubUrl],
  ["--team-url", teamUrl],
  ["--contact-url", contactUrl],
]) {
  if (valueAfter(flag) && !value) {
    fail(`${flag} must be a public http(s), wss, or ws URL`);
  }
}

const outPath =
  outArg || path.join(repoRoot, "registry/providers/community", `${id}.json`);
const outputPath = path.resolve(outPath);
const submissionFile = path.join("registry/providers/community", `${id}.json`);
const document = {
  schema_version: 1,
  submission: {
    submitted_by: submittedBy,
    submitted_by_url: `https://github.com/${submittedBy}`,
  },
  provider: {
    schema_version: 1,
    id,
    name,
    kind,
    website_url: websiteUrl,
    ...(docsUrl ? { docs_url: docsUrl } : {}),
    ...(githubUrl ? { github_url: githubUrl } : {}),
    ...(teamUrl ? { team_url: teamUrl } : {}),
    ...(contactUrl ? { contact_url: contactUrl } : {}),
    authority,
    public_notes: publicNotes,
  },
};

const report = buildPrSubmissionReport({
  changedFiles: [submissionFile],
  providerDocument: document,
  submitter: submittedBy,
  native: await loadNativeSnapshot(),
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
    provider: document.provider,
  }),
);

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] || null;
}

function normalizeOptionalUrl(value) {
  return value ? normalizePublicUrl(value) : null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
