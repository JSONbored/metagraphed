import path from "node:path";
import {
  buildTimestamp,
  corroboratingSources,
  generatedSourceRoot,
  isHtmlContentType,
  isJsonContentType,
  isUnsafeResolvedUrl,
  redactCredentialedUrl,
  loadCandidates,
  readCommittedManifestGeneratedAt,
  readJson,
  repoRoot,
  stableStringify,
  writeJson,
} from "./lib.ts";
import {
  classifyHttpProbe,
  isContentMismatch,
} from "./http-probe-classification.ts";
import {
  optionalHttpStatus,
  preservePreviousGithubMetadata,
} from "./verification-quality.ts";

// Candidate/probe/GitHub-API data is dynamic, untrusted JSON handled for
// scoring/reporting only, never trusted for control flow. Mirrors the
// readJson/readArtifactJson precedent in lib.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;
const candidates = await loadCandidates();
const previousVerificationByCandidate = await loadPreviousVerificationIndex();
const startedAt = new Date().toISOString();
const results = (await mapLimit(candidates, 16, verifyCandidate)).map(
  (result) =>
    preservePreviousGithubMetadata(result, previousVerificationByCandidate),
);
const finishedAt = new Date().toISOString();

const artifact = {
  schema_version: 1,
  generated_at: buildTimestamp(),
  verification_started_at: startedAt,
  verification_finished_at: finishedAt,
  candidate_count: candidates.length,
  summary: {
    by_classification: countBy(results, "classification"),
    by_kind: countBy(results, "kind"),
    by_provider: countBy(results, "provider"),
    promotable_count: results.filter((result) => isPromotable(result)).length,
  },
  results,
};

if (!dryRun) {
  await writeJson(
    path.join(generatedSourceRoot, "verification/latest.json"),
    artifact,
  );
  await writeJson(
    path.join(repoRoot, "registry/verification/promotions.json"),
    await compactVerificationArtifact(artifact),
  );
}

console.log(
  stableStringify({
    mode: dryRun ? "dry-run" : "write",
    candidate_count: artifact.candidate_count,
    summary: artifact.summary,
  }),
);

async function verifyCandidate(candidate: Row): Promise<Row> {
  const base = {
    candidate_id: candidate.id,
    kind: candidate.kind,
    name: candidate.name,
    netuid: candidate.netuid,
    provider: candidate.provider,
    source_tier: candidate.source_tier || null,
    source_type: candidate.source_type || null,
    source_url: candidate.source_url,
    source_urls: candidate.source_urls || [candidate.source_url],
    url: candidate.url,
    verified_at: new Date().toISOString(),
  };

  if (!candidate.public_safe || (await isUnsafeResolvedUrl(candidate.url))) {
    return {
      ...base,
      classification: "unsafe",
      status: "failed",
      error: "candidate is not public-safe",
    };
  }

  const githubRepo =
    candidate.kind === "source-repo" ? parseGithubRepo(candidate.url) : null;
  if (githubRepo) {
    return verifyGithubRepo(base, githubRepo);
  }

  return verifyHttpSurface(base, candidate);
}

async function loadPreviousVerificationIndex(): Promise<Map<unknown, Row>> {
  try {
    const previous = await readJson(
      path.join(repoRoot, "registry/verification/promotions.json"),
    );
    return new Map(
      ((previous.results as Row[] | undefined) || []).map((result) => [
        result.candidate_id,
        result,
      ]),
    );
  } catch {
    return new Map();
  }
}

async function compactVerificationArtifact(artifactValue: Row): Promise<Row> {
  const observedAt =
    process.env.METAGRAPH_VERIFICATION_OBSERVED_AT ||
    artifactValue.verification_finished_at ||
    null;
  // Preserve the committed promotions.json `generated_at` on a local build so
  // `npm run verify:candidates` never clobbers it with the 1970 epoch
  // placeholder; publish runs (METAGRAPH_BUILD_TIMESTAMP/RUN_ID set) get the
  // real build timestamp via buildTimestamp(). Mirrors the r2-manifest path.
  const generatedAt =
    (await readCommittedManifestGeneratedAt(
      path.join(repoRoot, "registry/verification/promotions.json"),
    )) ?? buildTimestamp();
  return {
    schema_version: artifactValue.schema_version,
    generated_at: generatedAt,
    observed_at: observedAt,
    verification_started_at: null,
    verification_finished_at: null,
    candidate_count: artifactValue.candidate_count,
    summary: artifactValue.summary,
    notes:
      "Compact promotion snapshot for deterministic Git review. Full latency, timestamp, and probe-detail rows are staged for R2 during refresh/publish runs.",
    results: artifactValue.results.map(compactVerificationResult),
  };
}

function compactVerificationResult(result: Row): Row {
  const compact: Row = {
    candidate_id: result.candidate_id,
    classification: result.classification,
    confidence_score: result.confidence_score,
    content_type: result.content_type,
    error: stableErrorCategory(result.error),
    kind: result.kind,
    netuid: result.netuid,
    provider: result.provider,
    quality_signals: compactQualitySignals(result.quality_signals, result.kind),
    status: result.status,
  };

  if (result.redirect_target) {
    compact.redirect_target = result.redirect_target;
  }
  if (result.private_redirect_blocked) {
    compact.private_redirect_blocked = result.private_redirect_blocked;
  }

  return stripNullish(compact);
}

function compactQualitySignals(
  signals: Row | null | undefined,
  kind: unknown = null,
) {
  if (!signals || typeof signals !== "object") {
    return signals;
  }
  if (kind === "source-repo") {
    return stripNullish({
      archived: signals.archived,
      has_default_branch: signals.has_default_branch,
      has_recent_push_metadata: signals.has_recent_push_metadata,
      public_safe: signals.public_safe,
      source_tier: signals.source_tier,
    });
  }
  return stripNullish({
    archived: signals.archived,
    content_type_matches_kind: signals.content_type_matches_kind,
    has_default_branch: signals.has_default_branch,
    has_recent_push_metadata: signals.has_recent_push_metadata,
    public_safe: signals.public_safe,
    rate_limited: signals.rate_limited,
    redirected: signals.redirected,
    source_tier: signals.source_tier,
    transient_failure: signals.transient_failure,
  });
}

function stableErrorCategory(error: unknown): string | null {
  if (!error) {
    return null;
  }
  const normalized = String(error).toLowerCase();
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return "timeout";
  }
  if (normalized.includes("rate limit") || normalized.includes("429")) {
    return "rate-limited";
  }
  if (normalized.includes("404") || normalized.includes("not found")) {
    return "not-found";
  }
  if (normalized.includes("403") || normalized.includes("forbidden")) {
    return "forbidden";
  }
  if (normalized.includes("content-type")) {
    return "content-mismatch";
  }
  return "probe-failed";
}

function stripNullish(value: Row): Row {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  );
}

async function verifyGithubRepo(
  base: Row,
  repo: { owner: string; repo: string },
): Promise<Row> {
  const apiUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
  const api = await fetchJson(apiUrl, githubHeaders());
  if (api.ok) {
    return githubMetadataResult(base, apiUrl, api.body, {
      classification: "live",
    });
  }

  let fallback = await probeUrl(
    base.url,
    "HEAD",
    "text/html,application/xhtml+xml",
  );
  if (!fallback.ok || [400, 403, 404, 405].includes(fallback.status_code)) {
    const getFallback = await probeUrl(
      base.url,
      "GET",
      "text/html,application/xhtml+xml",
    );
    if (getFallback.ok || !fallback.ok) {
      fallback = getFallback;
    }
  }

  const redirectedRepo = parseGithubRepo(fallback.redirect_target);
  if (redirectedRepo) {
    const redirectApiUrl = `https://api.github.com/repos/${redirectedRepo.owner}/${redirectedRepo.repo}`;
    const redirectApi = await fetchJson(redirectApiUrl, githubHeaders());
    if (redirectApi.ok) {
      return githubMetadataResult(base, redirectApiUrl, redirectApi.body, {
        api_error: api.error || null,
        api_status: optionalHttpStatus(api.status_code),
        classification: "redirected",
        latency_ms: fallback.latency_ms,
        method_tested: fallback.method_tested,
        redirect_target: fallback.redirect_target,
      });
    }
  }

  const classification = classifyHttpProbe(
    fallback as Row & { status_code: number },
  );
  return {
    ...base,
    classification,
    confidence_score: scoreCandidate(
      { ...base, kind: "source-repo", public_safe: true },
      { ...fallback, classification },
    ),
    error: api.error || fallback.error || null,
    github_api_url: apiUrl,
    github_api_status: optionalHttpStatus(api.status_code),
    latency_ms: fallback.latency_ms,
    method_tested: fallback.method_tested,
    private_redirect_blocked: fallback.private_redirect_blocked || false,
    quality_signals: qualitySignals(
      { ...base, kind: "source-repo", public_safe: true },
      { ...fallback, classification },
    ),
    redirect_target: redactCredentialedUrl(fallback.redirect_target),
    status: fallback.ok ? "ok" : "failed",
    status_code: fallback.status_code || null,
  };
}

function githubMetadataResult(
  base: Row,
  apiUrl: string,
  metadata: Row,
  options: Row = {},
): Row {
  const archived = Boolean(metadata.archived);
  const classification = archived
    ? "unsupported"
    : options.classification || "live";
  return stripNullish({
    ...base,
    archived,
    classification,
    confidence_score: archived ? 20 : 80,
    default_branch: metadata.default_branch || null,
    description: metadata.description || null,
    error: options.api_error ?? undefined,
    github_api_status: options.api_status ?? undefined,
    github_api_url: apiUrl,
    homepage: normalizeNullableUrl(metadata.homepage),
    html_url: metadata.html_url || base.url,
    last_push_at: metadata.pushed_at || null,
    latency_ms: options.latency_ms,
    method_tested: options.method_tested,
    quality_signals: stripNullish({
      archived,
      has_default_branch: Boolean(metadata.default_branch),
      has_recent_push_metadata: Boolean(metadata.pushed_at),
      public_safe: true,
      redirected: options.redirect_target ? true : undefined,
      source_tier: base.source_tier || null,
    }),
    redirect_target: redactCredentialedUrl(options.redirect_target),
    status: archived ? "failed" : "ok",
    topics: Array.isArray(metadata.topics)
      ? metadata.topics.slice().sort()
      : [],
  });
}

async function verifyHttpSurface(base: Row, candidate: Row): Promise<Row> {
  const accept = acceptHeader(candidate.kind);
  let probe = await probeUrl(candidate.url, "HEAD", accept);
  if (!probe.ok || [400, 403, 405].includes(probe.status_code)) {
    probe = await probeUrl(candidate.url, "GET", accept);
  }

  const classification = classifyHttpProbe(
    probe as Row & { status_code: number },
    candidate,
  );
  return {
    ...base,
    classification,
    content_type: probe.content_type || null,
    error: probe.error || null,
    latency_ms: probe.latency_ms,
    method_tested: probe.method_tested,
    private_redirect_blocked: probe.private_redirect_blocked || false,
    redirect_target: redactCredentialedUrl(probe.redirect_target),
    status: probe.ok ? "ok" : "failed",
    status_code: probe.status_code || null,
    confidence_score: scoreCandidate(candidate, { ...probe, classification }),
    quality_signals: qualitySignals(candidate, { ...probe, classification }),
  };
}

async function probeUrl(
  url: string,
  method: string,
  accept: string,
  redirectCount = 0,
): Promise<Row> {
  if (await isUnsafeResolvedUrl(url)) {
    return {
      ok: false,
      error: "unsafe URL",
      latency_ms: 0,
      method_tested: method,
      unsafe_url: true,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept,
        "user-agent": "metagraphed-candidate-verifier/0.0",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - started);
    const location = response.headers.get("location");
    if (
      [301, 302, 303, 307, 308].includes(response.status) &&
      location &&
      redirectCount < 5
    ) {
      const redirectTarget = new URL(location, url).toString();
      if (await isUnsafeResolvedUrl(redirectTarget)) {
        await response.body?.cancel();
        return {
          ok: false,
          error: "redirect target is unsafe",
          latency_ms: latencyMs,
          method_tested: method,
          private_redirect_blocked: true,
          redirect_target: redactCredentialedUrl(redirectTarget),
          status_code: response.status,
        };
      }
      await response.body?.cancel();
      const redirected = await probeUrl(
        redirectTarget,
        method,
        accept,
        redirectCount + 1,
      );
      return {
        ...redirected,
        latency_ms: latencyMs + (redirected.latency_ms || 0),
        redirect_target: redactCredentialedUrl(
          redirected.redirect_target || redirectTarget,
        ),
      };
    }

    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      const redirectTarget = new URL(location, url).toString();
      if (await isUnsafeResolvedUrl(redirectTarget)) {
        await response.body?.cancel();
        return {
          ok: false,
          error: "redirect target is unsafe",
          latency_ms: latencyMs,
          method_tested: method,
          private_redirect_blocked: true,
          redirect_target: redactCredentialedUrl(redirectTarget),
          status_code: response.status,
        };
      }
      await response.body?.cancel();
      return {
        ok: false,
        error: "redirect limit exceeded",
        latency_ms: latencyMs,
        method_tested: method,
        redirect_target: redactCredentialedUrl(redirectTarget),
        status_code: response.status,
      };
    }

    await response.body?.cancel();
    return {
      ok: response.ok,
      content_type: response.headers.get("content-type") || null,
      latency_ms: latencyMs,
      method_tested: method,
      redirect_target: null,
      status_code: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message,
      error_class: (error as Error).name,
      latency_ms: Math.round(performance.now() - started),
      method_tested: method,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string, headers: Row = {}): Promise<Row> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "metagraphed-candidate-verifier/0.0",
        ...headers,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      body: text ? JSON.parse(text) : null,
      status_code: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function isPromotable(result: Row): boolean {
  return ["live", "redirected"].includes(result.classification);
}

function scoreCandidate(candidate: Row, probe: Row): number {
  let score = 0;
  if (["live", "redirected"].includes(probe.classification)) {
    score += 45;
  }
  if (candidate.source_tier === "provider-claimed") {
    score += 20;
  } else if (candidate.source_tier === "third-party-index") {
    score += 14;
  } else if (candidate.source_tier === "community-docs") {
    score += 10;
  }
  if (candidate.confidence === "high") {
    score += 15;
  } else if (candidate.confidence === "medium") {
    score += 10;
  } else if (candidate.confidence === "low") {
    score += 3;
  }
  // #1007: corroboration bonus. 2+ independent discovery sources agreeing on the
  // same (netuid, kind, url) is strong signal, so a corroborated candidate scores
  // above an otherwise-identical single-source one. Additive — it never lowers a
  // score, so it cannot regress an existing promotion.
  if (corroboratingSources(candidate).length >= 2) {
    score += 8;
  }
  if (
    isJsonContentType(probe.content_type) &&
    ["openapi", "subnet-api", "data-artifact"].includes(candidate.kind)
  ) {
    score += 10;
  }
  if (
    isHtmlContentType(probe.content_type) &&
    ["website", "docs", "dashboard"].includes(candidate.kind)
  ) {
    score += 8;
  }
  if (probe.redirect_target) {
    score -= 5;
  }
  if (["rate-limited", "transient", "timeout"].includes(probe.classification)) {
    score -= 15;
  }
  if (["dead", "unsafe", "content-mismatch"].includes(probe.classification)) {
    score -= 40;
  }
  return Math.max(0, Math.min(100, score));
}

function qualitySignals(candidate: Row, probe: Row): Row {
  return {
    public_safe:
      candidate.public_safe === true &&
      !probe.unsafe_url &&
      !probe.private_redirect_blocked,
    source_tier: candidate.source_tier || null,
    content_type_matches_kind: !isContentMismatch(
      probe as Row & { status_code: number },
      candidate,
    ),
    redirected: Boolean(probe.redirect_target),
    rate_limited: probe.classification === "rate-limited",
    transient_failure: ["transient", "timeout"].includes(probe.classification),
  };
}

function acceptHeader(kind: unknown): string {
  switch (kind) {
    case "openapi":
      return "application/json,text/html;q=0.8,*/*;q=0.5";
    case "subnet-api":
      return "application/json,*/*;q=0.5";
    case "sse":
      return "text/event-stream";
    case "docs":
    case "dashboard":
    case "source-repo":
    case "website":
      return "text/html,application/xhtml+xml,*/*;q=0.5";
    default:
      return "*/*";
  }
}

function parseGithubRepo(
  value: unknown,
): { owner: string; repo: string } | null {
  try {
    const url = new URL(value as string);
    if (url.hostname !== "github.com") {
      return null;
    }
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo) {
      return null;
    }
    return { owner, repo: repo.replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

function githubHeaders(): Record<string, string> {
  if (!process.env.GITHUB_TOKEN) {
    return {};
  }
  return {
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    "x-github-api-version": "2022-11-28",
  };
}

function normalizeNullableUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<Row>,
): Promise<Row[]> {
  const queue = [...items];
  const results: Row[] = [];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift() as T;
        results.push(await mapper(item));
      }
    },
  );
  await Promise.all(workers);
  return results.sort(
    (a, b) =>
      a.netuid - b.netuid || a.candidate_id.localeCompare(b.candidate_id),
  );
}

function countBy(items: Row[], key: string): Record<string, number> {
  return Object.fromEntries(
    Object.entries(
      items.reduce<Record<string, number>>((accumulator, item) => {
        accumulator[item[key]] = (accumulator[item[key]] || 0) + 1;
        return accumulator;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}
