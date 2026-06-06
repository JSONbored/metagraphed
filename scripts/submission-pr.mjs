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
  buildPrSubmissionReport,
  normalizeChangedFiles,
} from "./submission-policy.mjs";

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
const candidateDocument = directCandidateFile
  ? await readJson(path.resolve(directCandidateFile))
  : null;
const existingCandidates = directCandidateFile
  ? (await loadCandidates()).filter(
      (candidate) =>
        !candidateDocument?.candidates?.some(
          (submitted) => submitted.id === candidate.id,
        ),
    )
  : await loadCandidates();

const report = buildPrSubmissionReport({
  changedFiles,
  candidateDocument,
  submitter,
  native: await loadNativeSnapshot(),
  providers: await loadProviders(),
  existingCandidates,
  existingSubnets: await loadSubnets(),
});

if (outPath) {
  await writeJson(path.resolve(outPath), report);
}

console.log(stableStringify(report));

if (failOnBlocking && report.blocking) {
  process.exit(1);
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] || null;
}
