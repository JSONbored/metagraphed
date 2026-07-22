#!/usr/bin/env node
// Scheduled drift guard (issue #5538, parent epic #4651; corrected by #7224):
// the Worker CODE deploys via Cloudflare Workers Builds on push to main (a
// Cloudflare-side git integration, not a GitHub Actions step -- see
// publish-cloudflare.yml's header), so nothing in this repo previously
// verified that a Builds deploy actually landed. A stuck build leaves the
// live Worker silently drifting stale vs. main with no signal here. This
// compares the live deployment's commit -- read from the workers/message
// annotation that scripts/deploy-worker-with-sourcemaps.sh's `--message
// "$(git rev-parse HEAD)"` sets on every deploy -- against origin/main HEAD,
// falling back to Sentry's release tracking if that annotation is ever
// absent (e.g. a deployment predating the #7224 fix), and fails the
// scheduled job once the drift has persisted across a prior scheduled run
// (see evaluateDeployDrift below for the grace-window rule).
//
// #7224: this previously read a `workers/commit_hash` annotation that never
// existed for Cloudflare Workers deployments (confirmed against wrangler's
// own CLI source and Cloudflare's List Deployments API reference -- only
// `workers/message`, `workers/tag`, and `workers/triggered_by` are real;
// `commit_hash` is exclusively a Cloudflare Pages deploy-command concept, a
// different product). Nothing was ever going to populate it.
import { fileURLToPath } from "node:url";

type Row = Record<string, unknown>;

const DEPLOYMENTS_PATH_TEMPLATE =
  "https://api.cloudflare.com/client/v4/accounts/{accountId}/workers/scripts/{scriptName}/deployments";
const SENTRY_RELEASES_PATH_TEMPLATE =
  "https://sentry.io/api/0/projects/{org}/{project}/releases/";
// A bare 40-hex-char git SHA is what both a real deployment's workers/message
// annotation (deploy-worker-with-sourcemaps.sh's --message) and a real
// production Sentry release's version (workers/api.sentry.ts's
// `release: env.SENTRY_RELEASE || ...`) should contain. PR-preview deploys
// (apps/ui/.github/workflows/ui-preview-deploy.yml) tag Sentry releases
// "<sha>-preview" -- excluded so a preview build is never mistaken for what's
// actually live in production.
const PRODUCTION_RELEASE_VERSION_PATTERN = /^[0-9a-f]{40}$/i;

export function extractDeployedCommitSha(deploymentsJson: Row): string {
  const deployments = (deploymentsJson?.result as Row | undefined)
    ?.deployments as Row[] | undefined;
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error(
      "Cloudflare deployments response contained no deployments for this Worker script",
    );
  }
  const active = deployments[0];
  const message = (active?.annotations as Row | undefined)?.[
    "workers/message"
  ] as string | undefined;
  if (!message || !PRODUCTION_RELEASE_VERSION_PATTERN.test(message)) {
    throw new Error(
      `Active deployment ${active?.id ?? "(unknown id)"} has no workers/message annotation containing a git commit SHA -- scripts/deploy-worker-with-sourcemaps.sh may not have deployed it (or it predates the --message fix, #7224)`,
    );
  }
  return message;
}

// Fallback for a deployment whose workers/message annotation is absent or
// not SHA-shaped (e.g. one predating the #7224 --message fix): @sentry/
// cloudflare's withSentry() (workers/api.sentry.ts) already tags every
// production error event with the real deployed commit SHA as its Sentry
// release, independent of Cloudflare's own deployment bookkeeping. Sorts by
// dateCreated rather than trusting response order, since that isn't
// documented/guaranteed.
export function selectLatestProductionRelease(
  releases: Row[] | null | undefined,
): Row | null {
  if (!Array.isArray(releases)) {
    return null;
  }
  const candidates = releases.filter(
    (release) =>
      typeof release?.version === "string" &&
      PRODUCTION_RELEASE_VERSION_PATTERN.test(release.version as string),
  );
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort(
    (a, b) =>
      new Date(b.dateCreated as string).getTime() -
      new Date(a.dateCreated as string).getTime(),
  )[0];
}

export async function findLatestProductionReleaseCommit({
  sentryAuthToken,
  sentryOrg,
  sentryProject,
}: {
  sentryAuthToken: string;
  sentryOrg: string;
  sentryProject: string;
}): Promise<string | null> {
  const releasesUrl = SENTRY_RELEASES_PATH_TEMPLATE.replace(
    "{org}",
    sentryOrg,
  ).replace("{project}", sentryProject);
  const res = await fetch(releasesUrl, {
    headers: { Authorization: `Bearer ${sentryAuthToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `Sentry releases API returned HTTP ${res.status}: ${await res.text()}`,
    );
  }
  const latest = selectLatestProductionRelease((await res.json()) as Row[]);
  return (latest?.version as string | undefined) ?? null;
}

export function findPreviousScheduledRunAt(
  runsJson: Row,
  currentRunId: unknown,
): string | null {
  const runs = Array.isArray(runsJson?.workflow_runs)
    ? (runsJson.workflow_runs as Row[])
    : [];
  const previous = runs
    .filter((run) => String(run.id) !== String(currentRunId))
    .sort(
      (a, b) =>
        new Date(b.created_at as string).getTime() -
        new Date(a.created_at as string).getTime(),
    )[0];
  return (previous?.created_at as string | undefined) ?? null;
}

interface DeployDriftResult {
  drifted: boolean;
  shouldAlert: boolean;
  reason: string;
}

// Grace window, per issue #5538: skip the very first scheduled run that observes a
// drift (a normal in-flight Builds deploy), only alert once the drift already
// existed as of the PREVIOUS scheduled run -- i.e. it has persisted across a full
// scheduled interval, not just "since the last push". Deliberately time-boundary-
// free (no arbitrary hour threshold): it reuses the scheduled run history GitHub
// Actions already retains instead of inventing separate persisted state.
export function evaluateDeployDrift({
  deployedCommitSha,
  mainHeadSha,
  mainHeadCommittedAt,
  previousScheduledRunAt,
}: {
  deployedCommitSha: string;
  mainHeadSha: string;
  mainHeadCommittedAt: string;
  previousScheduledRunAt: string | null;
}): DeployDriftResult {
  if (deployedCommitSha === mainHeadSha) {
    return {
      drifted: false,
      shouldAlert: false,
      reason: `deployed commit ${deployedCommitSha} matches origin/main HEAD`,
    };
  }
  if (!previousScheduledRunAt) {
    return {
      drifted: true,
      shouldAlert: false,
      reason: `origin/main HEAD ${mainHeadSha} (pushed ${mainHeadCommittedAt}) is not yet deployed (live: ${deployedCommitSha}), but there is no prior scheduled run to compare against -- within the grace window`,
    };
  }
  const pushedBeforePreviousRun =
    new Date(mainHeadCommittedAt).getTime() <
    new Date(previousScheduledRunAt).getTime();
  if (!pushedBeforePreviousRun) {
    return {
      drifted: true,
      shouldAlert: false,
      reason: `origin/main HEAD ${mainHeadSha} was pushed after the previous scheduled run (${previousScheduledRunAt}) -- this is the first scheduled run to observe the drift, within the grace window`,
    };
  }
  return {
    drifted: true,
    shouldAlert: true,
    reason: `origin/main HEAD ${mainHeadSha} (pushed ${mainHeadCommittedAt}) is still undeployed (live: ${deployedCommitSha}) as of the previous scheduled run (${previousScheduledRunAt}) -- drift has persisted across more than one scheduled run`,
  };
}

async function main(): Promise<number> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const scriptName = process.env.WORKER_SCRIPT_NAME || "metagraphed";
  const mainHeadSha = process.env.MAIN_HEAD_SHA;
  const mainHeadCommittedAt = process.env.MAIN_HEAD_COMMITTED_AT;
  const githubToken = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const workflowFilename = process.env.WORKFLOW_FILENAME;

  if (!accountId || !apiToken) {
    console.error(
      "::error::CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required to check the live Worker deployment -- a contributor PR cannot supply these, a maintainer must configure the repo secrets.",
    );
    return 1;
  }
  if (!mainHeadSha || !mainHeadCommittedAt) {
    console.error(
      "::error::MAIN_HEAD_SHA and MAIN_HEAD_COMMITTED_AT must be set from a fresh checkout before running this check.",
    );
    return 1;
  }

  const deploymentsUrl = DEPLOYMENTS_PATH_TEMPLATE.replace(
    "{accountId}",
    accountId,
  ).replace("{scriptName}", scriptName);
  const deploymentsRes = await fetch(deploymentsUrl, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });
  if (deploymentsRes.status === 401 || deploymentsRes.status === 403) {
    console.error(
      `::error::CLOUDFLARE_API_TOKEN lacks permission to read Worker deployments for '${scriptName}' (HTTP ${deploymentsRes.status}). Grant the token Workers Scripts read access -- a contributor PR cannot change token scope, this needs a maintainer.`,
    );
    return 1;
  }
  if (!deploymentsRes.ok) {
    console.error(
      `::error::Cloudflare deployments API returned HTTP ${deploymentsRes.status}: ${await deploymentsRes.text()}`,
    );
    return 1;
  }

  let deployedCommitSha: string;
  try {
    deployedCommitSha = extractDeployedCommitSha(
      (await deploymentsRes.json()) as Row,
    );
  } catch (cfError) {
    // Fall back to Sentry's release tracking (see findLatestProductionReleaseCommit
    // above) rather than failing outright -- this is what actually let a maintainer
    // confirm live code was current while this annotation gap was unresolved.
    const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
    if (!sentryAuthToken) {
      console.error(`::error::${(cfError as Error).message}`);
      return 1;
    }
    console.error(
      `::warning::${(cfError as Error).message} -- falling back to Sentry's latest release commit.`,
    );
    let fallbackSha: string | null;
    try {
      fallbackSha = await findLatestProductionReleaseCommit({
        sentryAuthToken,
        sentryOrg: process.env.SENTRY_ORG || "jsonbored",
        sentryProject: process.env.SENTRY_PROJECT || "metagraphed",
      });
    } catch (sentryError) {
      console.error(`::error::${(cfError as Error).message}`);
      console.error(
        `::error::Sentry fallback also failed: ${(sentryError as Error).message}`,
      );
      return 1;
    }
    if (!fallbackSha) {
      console.error(`::error::${(cfError as Error).message}`);
      console.error(
        "::error::Sentry fallback found no production release either.",
      );
      return 1;
    }
    deployedCommitSha = fallbackSha;
  }

  let previousScheduledRunAt: string | null = null;
  if (githubToken && repository && workflowFilename) {
    const runsUrl = `https://api.github.com/repos/${repository}/actions/workflows/${workflowFilename}/runs?event=schedule&status=completed&per_page=5`;
    const runsRes = await fetch(runsUrl, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!runsRes.ok) {
      console.error(
        `::error::GitHub Actions API returned HTTP ${runsRes.status} while listing previous scheduled runs: ${await runsRes.text()}`,
      );
      return 1;
    }
    previousScheduledRunAt = findPreviousScheduledRunAt(
      (await runsRes.json()) as Row,
      runId,
    );
  }

  const result = evaluateDeployDrift({
    deployedCommitSha,
    mainHeadSha,
    mainHeadCommittedAt,
    previousScheduledRunAt,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.shouldAlert) {
    console.error(`::error::${result.reason}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`::error::${error.stack || error.message}`);
      process.exit(1);
    });
}
