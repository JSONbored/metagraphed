import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main(process.argv.slice(2));
}

export function buildSubmissionMarkdown(report) {
  const lines = [
    "## Metagraphed Submission Preflight",
    "",
    `State: \`${report.public_state || report.state || "unknown"}\``,
    `Next action: \`${report.next_action || "unknown"}\``,
    `Blocking: \`${Boolean(report.blocking)}\``,
  ];

  if (report.direct_candidate_file) {
    lines.push(`Candidate file: \`${report.direct_candidate_file}\``);
  }

  lines.push("");
  appendList(lines, "Errors", report.errors);
  appendList(lines, "Warnings", report.warnings);
  appendList(lines, "Manual review reasons", report.manual_reasons);

  const candidate = report.candidate || report.candidates?.[0] || null;
  if (candidate) {
    lines.push("Candidate:", "");
    lines.push(`- netuid: \`${candidate.netuid}\``);
    lines.push(`- kind: \`${candidate.kind}\``);
    lines.push(`- provider: \`${candidate.provider}\``);
    lines.push(`- url: ${candidate.url}`);
    lines.push(`- source: ${candidate.source_url}`);
  }

  if (report.provider) {
    lines.push("Provider:", "");
    lines.push(`- id: \`${report.provider.id}\``);
    lines.push(`- kind: \`${report.provider.kind}\``);
    lines.push(`- website: ${report.provider.website_url}`);
  }

  if (report.report) {
    lines.push("Status report:", "");
    lines.push(`- netuid: \`${report.report.netuid}\``);
    lines.push(`- issue_type: \`${report.report.issue_type}\``);
    lines.push("- observed health remains probe-derived");
  }

  lines.push(
    "",
    "Public preflight is deterministic validation only. Private gate review or maintainer review is still required before publication.",
    "",
  );
  return lines.join("\n");
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
    lines.push(`- ${String(value)}`);
  }
  lines.push("");
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] || null;
}
