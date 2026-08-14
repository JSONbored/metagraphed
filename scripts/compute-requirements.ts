// #11097: the build lane behind the per-subnet hardware-requirements facet.
//
// Sibling of scripts/github-signals.ts, and deliberately shaped like it: probe
// each resolved source repo, write ONE committed seed
// (registry/generated/compute-requirements.json), and have the build read that
// seed rather than the network -- which is what keeps
// tests/artifacts-build-determinism.test.ts network-free and the artifacts
// reproducible.
//
// The refresh happens on the sync-subnets cadence: `pipeline:refresh` runs this
// with `--write`, and the workflow's existing capture step carries
// registry/generated/** into its auto-merged PR. No new cron, no new workflow.
//
// ## WHY THIS DOES NOT WRITE compute_declarations
//
// The hourly Worker lane (src/compute-declarations-lane.ts) reads the 18
// REGISTERED min_compute surfaces into Neon and /cost-to-participate serves
// them. That lane's subject list is the registry; this one's is the resolved
// source repo, which is a superset (39 repos publish the file). They share the
// parser and the tri-state, so where both read the same file they say the same
// thing -- and the facet carries its own citation, so a reader can always see
// WHICH file and WHICH commit the screening number came from.
//
// ## FAILURE IS ABSENCE, NEVER A BUILD FAILURE
//
// A repo with no file, or one whose reading cannot be cited, yields NO ENTRY,
// and `summary.uncited` counts it so a run is auditable. #11097 asks for
// exactly that -- "absence plus a build-visible count, not a failure" -- and it
// matches the posture of every other live-data refresh in this pipeline.
//
// With ONE exception, learned by running it twice: an unauthenticated re-read
// exhausts GitHub's 60/hour commits budget partway through and every repo after
// that point looks exactly like a repo that deleted its file. A repo that has
// been read before therefore keeps its last-good reading for 30 days
// (`summary.retained` says how many), so a bad run cannot silently shrink the
// served facet.
import path from "node:path";
import {
  loadNativeSnapshot,
  loadSubnets,
  readJson,
  repoRoot,
  writeJson,
  backfilledIdentityUrl,
} from "./lib.ts";
import {
  githubRepoMapKey,
  parseGithubRepoUrl,
  githubHeaders,
  type GithubRepoRef,
} from "./github-signals.ts";
import {
  parseComputeSpec,
  resolveReadSha,
} from "../src/compute-declarations-lane.ts";
import {
  computeProbeTargets,
  summariseComputeRequirements,
  MIN_COMPUTE_MAX_BYTES,
  type ComputeRequirements,
} from "../src/compute-requirements.ts";

type Row = Record<string, unknown>;

export const computeRequirementsPath = path.join(
  repoRoot,
  "registry/generated/compute-requirements.json",
);

export interface ComputeRequirementsCaptureSummary {
  repos_probed: number;
  files_found: number;
  specs_parsed: number;
  read_without_spec: number;
  uncited: number;
  retained: number;
}

export interface CaptureDeps {
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  capturedAt?: string;
  /**
   * The previous capture, keyed by repo.
   *
   * `observed_at` is PRESERVED from it whenever the re-read lands on the same
   * commit, which is what keeps this a content-only diff: the seed refreshes
   * daily, and a date that moved on every run would churn the sync PR while
   * telling a reader nothing -- the declaration did not move, the lane just ran.
   * Unlike github-signals, this seed is what production SERVES (there is no R2
   * store in front of it), so the date has to be a real one.
   */
  previousByRepo?: Map<string, ComputeRequirements>;
}

/**
 * Probe one repo for a min_compute file and read it.
 *
 * Null when no candidate answered 200, when the body is too large to be a
 * compute spec, or when the commit that last touched the file cannot be
 * resolved -- a reading with no citation is not a reading, the same rule the
 * registered-surface lane holds itself to.
 */
export async function captureRepoRequirements(
  ref: GithubRepoRef,
  deps: CaptureDeps = {},
): Promise<ComputeRequirements | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  for (const target of computeProbeTargets(ref.owner, ref.repo)) {
    const res = await doFetch(target.url, {
      headers: { "user-agent": "metagraphed-compute-requirements" },
    }).catch(() => null);
    if (!res || !res.ok) continue;
    const text = await res.text();
    if (text.length > MIN_COMPUTE_MAX_BYTES) return null;
    const sha = await resolveReadSha(
      {
        owner: ref.owner,
        repo: ref.repo,
        ref: target.branch,
        path: target.path,
      },
      {
        fetchImpl: deps.fetchImpl,
        githubAuth: deps.headers?.authorization ?? null,
      },
    ).catch(() => null);
    if (!sha) return null;
    return summariseComputeRequirements(parseComputeSpec(text), {
      source_url: target.url,
      read_at_sha: sha,
      path: target.path,
      observed_at: deps.capturedAt ?? new Date().toISOString(),
    });
  }
  return null;
}

export interface ComputeRequirementsArtifact extends Row {
  generated_at: string;
  summary: ComputeRequirementsCaptureSummary;
  requirements: (ComputeRequirements & { owner: string; repo: string })[];
}

/**
 * How long a reading survives a failed re-read.
 *
 * A run that cannot reach GitHub -- the unauthenticated commits API allows 60
 * requests an hour, and this lane makes one per repo that has a file -- fails
 * EXACTLY like a repo that deleted its min_compute file: no record. Dropping on
 * the first such run would shrink the served facet from 39 subnets to whatever
 * that run managed, and the next run would silently restore it.
 *
 * So a failed re-read KEEPS the previous reading for 30 days, the same window
 * and the same reasoning as github-signals' last-good retention (#8379). Past
 * that, a file nobody has been able to read for a month is treated as gone.
 */
export const COMPUTE_REQUIREMENTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Whether a previous reading is still worth carrying through a failed
 * re-read. Unparseable/absent dates do not retain: a reading that cannot be
 * aged cannot be kept on the strength of its age. */
export function retainsPreviousReading(
  previous: ComputeRequirements | undefined,
  now: number,
): previous is ComputeRequirements {
  const observedAt = Date.parse(previous?.evidence?.observed_at ?? "");
  return (
    Number.isFinite(observedAt) &&
    now - observedAt <= COMPUTE_REQUIREMENTS_RETENTION_MS
  );
}

/** Probe every repo, in the order given, into one artifact. */
export async function captureComputeRequirements(
  repos: readonly GithubRepoRef[],
  deps: CaptureDeps = {},
): Promise<ComputeRequirementsArtifact> {
  const requirements: ComputeRequirementsArtifact["requirements"] = [];
  const now = Date.parse(deps.capturedAt ?? "") || Date.now();
  let readWithoutSpec = 0;
  let uncited = 0;
  let retained = 0;
  for (const ref of repos) {
    const record = await captureRepoRequirements(ref, deps);
    if (!record) {
      const lastGood = deps.previousByRepo?.get(
        githubRepoMapKey(ref.owner, ref.repo),
      );
      if (retainsPreviousReading(lastGood, now)) {
        retained += 1;
        requirements.push({ ...lastGood, owner: ref.owner, repo: ref.repo });
        continue;
      }
      uncited += 1;
      continue;
    }
    if (!record.found) readWithoutSpec += 1;
    const previous = deps.previousByRepo?.get(
      githubRepoMapKey(ref.owner, ref.repo),
    );
    const observed_at =
      previous?.evidence?.read_at_sha === record.evidence.read_at_sha
        ? previous.evidence.observed_at
        : record.evidence.observed_at;
    requirements.push({
      ...record,
      evidence: { ...record.evidence, observed_at },
      owner: ref.owner,
      repo: ref.repo,
    });
  }
  return {
    generated_at: deps.capturedAt ?? new Date().toISOString(),
    summary: {
      repos_probed: repos.length,
      files_found: requirements.length,
      specs_parsed: requirements.filter((entry) => entry.found).length,
      read_without_spec: readWithoutSpec,
      // "No file, or one we could not cite." Counted, never fatal, and the
      // number is what makes a coverage drop visible in the sync PR's diff.
      uncited,
      // How many entries are last-good rather than re-read this run. A run
      // that retains most of the fleet is a run that could not reach GitHub,
      // and the number says so instead of the diff looking clean.
      retained,
    },
    requirements,
  };
}

/**
 * The captured facets, keyed by repo.
 *
 * Keyed by REPO rather than netuid because the file belongs to the repo and
 * several subnets share one (the same reason github-signals keys this way).
 * A missing/malformed seed yields an empty map, never a throw: the facet
 * degrades to null on every subnet, which is the same answer 90 subnets get
 * anyway.
 */
export async function loadComputeRequirements(): Promise<
  Map<string, ComputeRequirements>
> {
  const doc: Row | null = await readJson(computeRequirementsPath).catch(
    () => null,
  );
  const entries: Row[] = Array.isArray(doc?.requirements)
    ? (doc?.requirements as Row[])
    : [];
  return new Map(
    entries
      .filter((entry) => entry?.owner && entry?.repo)
      .map((entry) => [
        githubRepoMapKey(entry.owner as string, entry.repo as string),
        {
          found: entry.found === true,
          miner: (entry.miner as ComputeRequirements["miner"]) ?? null,
          validator:
            (entry.validator as ComputeRequirements["validator"]) ?? null,
          evidence: entry.evidence as ComputeRequirements["evidence"],
        },
      ]),
  );
}

/**
 * One subnet's facet, looked up by the source repo the row already resolved.
 *
 * Takes the RESOLVED url rather than the overlay/native pair so the facet and
 * the row's own `source_repo` can never describe different repos -- they are
 * the same string. Null for a subnet with no GitHub source repo, and for one
 * whose repo publishes no readable file: both are "we have nothing", which is
 * the honest answer for 90 of 129 subnets.
 */
export function computeRequirementsForRepoUrl(
  byRepo: Map<string, ComputeRequirements>,
  sourceRepo: unknown,
): ComputeRequirements | null {
  const parsed = parseGithubRepoUrl(sourceRepo);
  if (!parsed) return null;
  return byRepo.get(githubRepoMapKey(parsed.owner, parsed.repo)) ?? null;
}

/** Every resolved source repo, deduped -- the same list github-signals tracks,
 * built the same way, because both lanes ask GitHub about the same repos. */
export async function resolveRequirementRepos(): Promise<GithubRepoRef[]> {
  const [overlays, nativeSnapshot]: [Row[], Row] = await Promise.all([
    loadSubnets(),
    loadNativeSnapshot(),
  ]);
  const overlayByNetuid = new Map(
    overlays.map((overlay) => [overlay.netuid, overlay]),
  );
  const reposByKey = new Map<string, GithubRepoRef>();
  for (const nativeSubnet of (nativeSnapshot.subnets as Row[]) || []) {
    const parsed = parseGithubRepoUrl(
      backfilledIdentityUrl(
        overlayByNetuid.get(nativeSubnet.netuid)?.source_repo,
        (nativeSubnet.chain_identity as Row | undefined)?.github_repo,
      ),
    );
    if (!parsed) continue;
    const key = githubRepoMapKey(parsed.owner, parsed.repo);
    if (!reposByKey.has(key)) reposByKey.set(key, parsed);
  }
  return [...reposByKey.values()];
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const shouldWrite = args.has("--write");
  // Tolerant by design, like every other live-data refresh step here: a failure
  // keeps whatever seed is committed and the build proceeds with it.
  try {
    const repos = await resolveRequirementRepos();
    const artifact = await captureComputeRequirements(repos, {
      headers: githubHeaders(),
      // A REAL time, not the 1970 build placeholder: this seed is served, and
      // it is only ever stamped onto a declaration that actually moved.
      capturedAt: new Date().toISOString(),
      previousByRepo: await loadComputeRequirements(),
    });
    if (shouldWrite) await writeJson(computeRequirementsPath, artifact);
    console.log(
      `compute-requirements: probed ${artifact.summary.repos_probed} repos, ` +
        `read ${artifact.summary.files_found} files ` +
        `(${artifact.summary.specs_parsed} with a compute_spec, ` +
        `${artifact.summary.read_without_spec} without), ` +
        `${artifact.summary.uncited} with no readable file, ` +
        `${artifact.summary.retained} retained from the previous run` +
        `${shouldWrite ? "" : " (dry run -- pass --write to update the seed)"}`,
    );
  } catch (error) {
    console.warn(
      `compute-requirements: capture skipped (${(error as Error)?.message ?? error})`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
