import { stableStringify } from "./lib.mjs";

const args = process.argv.slice(2);
const url =
  valueAfter("--url") || "https://submission-gate.metagraph.sh/health";
const allowNonProduction = args.includes("--allow-non-production");

let response;
try {
  response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "metagraphed-submission-gate-health",
    },
    signal: AbortSignal.timeout(15_000),
  });
} catch (error) {
  fail(`Submission gate health request failed: ${error.message}`);
}

let body;
try {
  body = await response.json();
} catch (error) {
  fail(`Submission gate health response was not JSON: ${error.message}`);
}

const readiness = body?.readiness || {};
const blockers = Array.isArray(readiness.production_blockers)
  ? readiness.production_blockers
  : [];
const requiredBooleans = [
  "ai_binding",
  "ai_review_enabled",
  "d1",
  "discord",
  "github_app_configured",
  "github_webhook_secret",
  "github_write",
  "private_reviewer",
  "queue",
  "r2_audit",
];
const missingFields = requiredBooleans.filter(
  (field) => typeof readiness[field] !== "boolean",
);

const result = {
  ok: response.ok && body?.ok === true && missingFields.length === 0,
  url,
  status: response.status,
  production_ready: readiness.production_ready === true,
  production_blockers: blockers,
  github_write_mode: readiness.github_write_mode || "unknown",
  missing_fields: missingFields,
};

console.log(stableStringify(result));

if (!response.ok || body?.ok !== true) {
  fail(`Submission gate health returned ${response.status}`);
}
if (missingFields.length > 0) {
  fail(
    `Submission gate health is missing field(s): ${missingFields.join(", ")}`,
  );
}
if (!allowNonProduction && readiness.production_ready !== true) {
  fail(
    `Submission gate is not production-ready: ${blockers.join(", ") || "unknown blocker"}`,
  );
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] || null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
