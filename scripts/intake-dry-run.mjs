import { promises as fs } from "node:fs";
import path from "node:path";
import {
  loadNativeSnapshot,
  loadProviders,
  repoRoot,
  stableStringify,
  writeJson,
} from "./lib.mjs";
import {
  SUBMISSION_LABELS,
  buildIssueIntakeReport,
} from "./submission-policy.mjs";

const args = process.argv.slice(2);
const issueJsonPath = valueAfter("--issue-json");
const outPath = valueAfter("--out");
const write = args.includes("--write");
const native = await loadNativeSnapshot();
const providers = await loadProviders();
const report = buildIssueIntakeReport({
  issue: issueJsonPath
    ? JSON.parse(await fs.readFile(issueJsonPath, "utf8"))
    : null,
  native,
  providers,
});

if (outPath) {
  await writeJson(path.resolve(outPath), report);
}

if (write) {
  if (!report.import_allowed) {
    console.error(
      `Refusing to import without schema-valid intake and ${SUBMISSION_LABELS.importApproved} approval label.`,
    );
    process.exit(1);
  }
  await writeJson(
    path.join(
      repoRoot,
      "registry/candidates/community",
      `${report.candidate.id}.json`,
    ),
    {
      schema_version: 1,
      generated_by: "metagraphed-intake-import",
      generated_at: report.generated_at,
      submission: {
        issue_number: report.issue?.number || null,
        submitted_by: report.issue?.author || null,
        submitted_by_url: report.issue?.author
          ? `https://github.com/${report.issue.author}`
          : null,
        review_marker: report.review_marker,
      },
      candidates: [report.candidate],
    },
  );
}

console.log(stableStringify(report));

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] || null;
}
