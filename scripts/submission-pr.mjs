import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import {
  loadCandidates,
  loadNativeSnapshot,
  loadProviders,
  loadSubnets,
  readJson,
  stableStringify,
  writeJson,
} from "./lib.mjs";
import {
  DIRECT_CANDIDATE_PATTERN,
  DIRECT_PROVIDER_PATTERN,
  buildPrSubmissionReport,
  normalizeChangedFiles,
} from "./submission-policy.mjs";
import { submissionFormattingErrors } from "./submission-formatting.mjs";

const args = process.argv.slice(2);
const changedFilesPath = valueAfter("--changed-files");
const outPath = valueAfter("--out");
const inputRoot = path.resolve(valueAfter("--input-root") || process.cwd());
const submitter =
  valueAfter("--submitter") || process.env.GITHUB_ACTOR || process.env.USER;
const failOnBlocking = !args.includes("--no-fail");

if (!changedFilesPath) {
  console.error("--changed-files is required");
  process.exit(1);
}

const changedFiles = normalizeChangedFiles(
  await fs.readFile(changedFilesPath, "utf8"),
);
// A delete-only direct submission REMOVES the candidate/provider file — it's absent from the working
// tree. A removal is a registry DELETION, not a content submission to validate; reading the missing file
// ENOENT-ed the whole preflight and false-failed maintainer cleanup #944. Drop removed direct files so a
// pure removal routes as a normal/non-submission PR (and passes); the review gate + maintainer authorize
// the deletion separately. (#candidate-deletion)
// Use the broad community-dir prefix (matching classifyPrScope's touchedCommunity* check), not just the
// strict DIRECT_*_PATTERN, so ANY removed candidate/provider file is recognized as a deletion.
const isRemovedDirectFile = (file) =>
  (file.startsWith("registry/candidates/community/") ||
    file.startsWith("registry/providers/community/")) &&
  file.endsWith(".json") &&
  !existsSync(path.join(inputRoot, file));
const removedDirectFiles = changedFiles.filter(isRemovedDirectFile);
const effectiveChangedFiles = changedFiles.filter((file) => !isRemovedDirectFile(file));
if (removedDirectFiles.length > 0) {
  console.log(
    `Submission preflight: ${removedDirectFiles.length} removed direct file(s) treated as registry deletion(s): ${removedDirectFiles.join(", ")}`,
  );
}
const directCandidateFile = effectiveChangedFiles.find((file) =>
  DIRECT_CANDIDATE_PATTERN.test(file),
);
const directProviderFile = effectiveChangedFiles.find((file) =>
  DIRECT_PROVIDER_PATTERN.test(file),
);
const candidateDocument = directCandidateFile
  ? await readJson(path.join(inputRoot, directCandidateFile))
  : null;
const providerDocument = directProviderFile
  ? await readJson(path.join(inputRoot, directProviderFile))
  : null;
const directSubmissionRaw = new Map(
  (
    await Promise.all(
      [directCandidateFile, directProviderFile]
        .filter(Boolean)
        .map(async (file) => [
          file,
          await fs.readFile(path.join(inputRoot, file), "utf8"),
        ]),
    )
  ).map(([file, raw]) => [file, raw]),
);
const existingCandidates = directCandidateFile
  ? (await loadCandidates()).filter(
      (candidate) =>
        !candidateDocument?.candidates?.some(
          (submitted) => submitted.id === candidate.id,
        ),
    )
  : await loadCandidates();
const existingProviders = directProviderFile
  ? (await loadProviders()).filter(
      (provider) => provider.id !== providerDocument?.provider?.id,
    )
  : await loadProviders();

const report = buildPrSubmissionReport({
  changedFiles: effectiveChangedFiles,
  candidateDocument,
  providerDocument,
  submitter,
  native: await loadNativeSnapshot(),
  providers: existingProviders,
  existingCandidates,
  existingSubnets: await loadSubnets(),
});

const formattingErrors = await submissionFormattingErrors([
  {
    file: directCandidateFile,
    raw: directSubmissionRaw.get(directCandidateFile),
    document: candidateDocument,
  },
  {
    file: directProviderFile,
    raw: directSubmissionRaw.get(directProviderFile),
    document: providerDocument,
  },
]);
const outputReport =
  formattingErrors.length === 0
    ? report
    : {
        ...report,
        state: "schema-invalid",
        public_state: "fix_required",
        errors: [...report.errors, ...formattingErrors],
        error_categories: [
          ...report.error_categories,
          ...formattingErrors.map(() => "unsupported-shape"),
        ],
        blocking: true,
        private_review_required: false,
        next_action: "resubmission-needed",
      };

if (outPath) {
  await writeJson(path.resolve(outPath), outputReport);
}

console.log(stableStringify(outputReport));

if (failOnBlocking && outputReport.blocking) {
  process.exit(1);
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] || null;
}
