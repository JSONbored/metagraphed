import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import { SUBMISSION_REVIEW_MARKER } from "./submission-policy.mjs";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main(process.argv.slice(2));
}

export function buildSubmissionMarkdown(report) {
  const lines = [
    report.review_marker || SUBMISSION_REVIEW_MARKER,
    "",
    "## Metagraphed Submission Preflight",
    "",
    `State: ${formatMarkdownValue(report.public_state || report.state || "unknown")}`,
    `Next action: ${formatMarkdownValue(report.next_action || "unknown")}`,
    `Blocking: ${formatMarkdownValue(Boolean(report.blocking))}`,
  ];

  if (report.direct_candidate_file) {
    lines.push(
      `Candidate file: ${formatMarkdownValue(report.direct_candidate_file)}`,
    );
  }
  if (report.direct_provider_file) {
    lines.push(
      `Provider file: ${formatMarkdownValue(report.direct_provider_file)}`,
    );
  }

  lines.push("");
  appendList(lines, "Errors", report.errors);
  appendList(lines, "Warnings", report.warnings);
  appendList(lines, "Manual review reasons", report.manual_reasons);

  const candidate = report.candidate || report.candidates?.[0] || null;
  if (candidate) {
    lines.push("Candidate:", "");
    lines.push(`- netuid: ${formatMarkdownValue(candidate.netuid)}`);
    lines.push(`- kind: ${formatMarkdownValue(candidate.kind)}`);
    lines.push(`- provider: ${formatMarkdownValue(candidate.provider)}`);
    lines.push(`- url: ${formatMarkdownValue(candidate.url)}`);
    lines.push(`- source: ${formatMarkdownValue(candidate.source_url)}`);
  }

  if (report.provider) {
    lines.push("Provider:", "");
    lines.push(`- id: ${formatMarkdownValue(report.provider.id)}`);
    lines.push(`- kind: ${formatMarkdownValue(report.provider.kind)}`);
    lines.push(
      `- website: ${formatMarkdownValue(report.provider.website_url)}`,
    );
  }

  if (report.report) {
    lines.push("Status report:", "");
    lines.push(`- netuid: ${formatMarkdownValue(report.report.netuid)}`);
    lines.push(
      `- issue_type: ${formatMarkdownValue(report.report.issue_type)}`,
    );
    lines.push("- observed health remains probe-derived");
  }

  lines.push(
    "",
    "Public preflight is deterministic validation only. Private gate review or maintainer review is still required before publication.",
    "",
  );
  return lines.join("\n");
}

export async function findSubmissionComment(
  github,
  {
    owner,
    repo,
    issueNumber,
    marker = SUBMISSION_REVIEW_MARKER,
    botLogin = "github-actions[bot]",
    maxPages = 2,
    perPage = 100,
  },
) {
  const pagesToScan = Math.max(1, maxPages);
  const commentsPerPage = Math.min(100, Math.max(1, perPage));
  let pagesScanned = 0;

  for await (const page of github.paginate.iterator(
    github.rest.issues.listComments,
    {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: commentsPerPage,
    },
  )) {
    pagesScanned += 1;
    const existing = page.data.find(
      (comment) =>
        comment.user?.type === "Bot" &&
        comment.user?.login === botLogin &&
        comment.body?.includes(marker),
    );

    if (existing) {
      return existing;
    }

    if (pagesScanned >= pagesToScan) {
      break;
    }
  }

  return null;
}

async function main(args) {
  const reportPath = valueAfter(args, "--report");
  const outPath = valueAfter(args, "--out");

  if (!reportPath) {
    console.error("--report is required");
    process.exit(1);
  }

  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  const markdown = buildSubmissionMarkdown(report);

  if (outPath) {
    await fs.writeFile(outPath, markdown, "utf8");
  }

  console.log(markdown);
}

function appendList(lines, title, values = []) {
  if (!values?.length) {
    return;
  }
  lines.push(`${title}:`);
  lines.push("");
  for (const value of values) {
    lines.push(`- ${formatMarkdownValue(value)}`);
  }
  lines.push("");
}

function formatMarkdownValue(value) {
  const markdownCharacters = new Set("\\&<>{}[]()#*_`|.!+-");
  let safeValue = "";

  for (const char of String(value)) {
    const codePoint = char.codePointAt(0);
    if (char === "\r") {
      safeValue += "\\r";
    } else if (char === "\n") {
      safeValue += "\\n";
    } else if (char === "\t") {
      safeValue += "\\t";
    } else if (codePoint < 0x20 || codePoint === 0x7f) {
      safeValue += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else if (markdownCharacters.has(char)) {
      safeValue += `\\${char}`;
    } else {
      safeValue += char;
    }
  }

  return safeValue;
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] || null;
}
