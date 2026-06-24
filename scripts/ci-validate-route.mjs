import { promises as fs } from "node:fs";
import {
  classifyPrScope,
  normalizeChangedFiles,
} from "./submission-policy.mjs";

const options = parseArgs(process.argv.slice(2));
const changedFiles = await readChangedFiles(options.changedFiles);
const classification = classifyPrScope(changedFiles);
const mode =
  classification.scope !== "normal-pr" && classification.errors.length === 0
    ? "ugc"
    : "full";

const report = {
  schema_version: 1,
  mode,
  scope: classification.scope,
  changed_files: normalizeChangedFiles(changedFiles),
  candidate_files: classification.candidateFiles,
  provider_files: classification.providerFiles,
  errors: classification.errors,
};

if (options.out) {
  await fs.writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
}

if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(
    process.env.GITHUB_OUTPUT,
    [`mode=${mode}`, `scope=${classification.scope}`].join("\n") + "\n",
  );
}

console.log(JSON.stringify(report, null, 2));

function parseArgs(args) {
  const parsed = {
    changedFiles: null,
    out: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--changed-files") {
      parsed.changedFiles = args[++index];
    } else if (arg === "--out") {
      parsed.out = args[++index];
    }
  }
  return parsed;
}

async function readChangedFiles(filePath) {
  if (!filePath) {
    return "";
  }
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}
