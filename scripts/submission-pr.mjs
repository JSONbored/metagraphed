import { promises as fs } from "node:fs";
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
const directCandidateFile = changedFiles.find((file) =>
  DIRECT_CANDIDATE_PATTERN.test(file),
);
const directProviderFile = changedFiles.find((file) =>
  DIRECT_PROVIDER_PATTERN.test(file),
);
const candidateDocument = directCandidateFile
  ? await readJson(path.resolve(directCandidateFile))
  : null;
const providerDocument = directProviderFile
  ? await readJson(path.resolve(directProviderFile))
  : null;
const directSubmissionRaw = new Map(
  (
    await Promise.all(
      [directCandidateFile, directProviderFile]
        .filter(Boolean)
        .map(async (file) => [
          file,
          await fs.readFile(path.resolve(file), "utf8"),
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
  changedFiles,
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
