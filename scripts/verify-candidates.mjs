import path from "node:path";
import {
  buildTimestamp,
  isHtmlContentType,
  isJsonContentType,
  isUnsafeUrlResolved,
  loadCandidates,
  repoRoot,
  stableStringify,
  writeJson,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;
const candidates = await loadCandidates();
const startedAt = new Date().toISOString();
const results = await mapLimit(candidates, 16, verifyCandidate);
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
    path.join(repoRoot, "registry/verification/latest.json"),
    artifact,
  );
}

console.log(
  stableStringify({
    mode: dryRun ? "dry-run" : "write",
    candidate_count: artifact.candidate_count,
    summary: artifact.summary,
  }),
);

async function verifyCandidate(candidate) {
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

  if (!candidate.public_safe || (await isUnsafeUrlResolved(candidate.url))) {
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

async function verifyGithubRepo(base, repo) {
  const apiUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
  const api = await fetchJson(apiUrl, githubHeaders());
  if (api.ok) {
    const metadata = api.body;
    const classification = metadata.archived ? "unsupported" : "live";
    return {
      ...base,
      archived: Boolean(metadata.archived),
      classification,
      confidence_score: metadata.archived ? 20 : 80,
      default_branch: metadata.default_branch || null,
      description: metadata.description || null,
      github_api_url: apiUrl,
      homepage: normalizeNullableUrl(metadata.homepage),
      html_url: metadata.html_url || base.url,
      last_push_at: metadata.pushed_at || null,
      quality_signals: {
        archived: Boolean(metadata.archived),
        has_default_branch: Boolean(metadata.default_branch),
        has_recent_push_metadata: Boolean(metadata.pushed_at),
        public_safe: true,
        source_tier: base.source_tier || null,
      },
      status: metadata.archived ? "failed" : "ok",
      topics: Array.isArray(metadata.topics)
        ? metadata.topics.slice().sort()
        : [],
    };
  }

  const fallback = await probeUrl(
    base.url,
    "HEAD",
    "text/html,application/xhtml+xml",
  );
  const classification = classifyHttpProbe(fallback);
  return {
    ...base,
    classification,
    confidence_score: scoreCandidate(
      { ...base, kind: "source-repo", public_safe: true },
      { ...fallback, classification },
    ),
    error: api.error || fallback.error || null,
    github_api_url: apiUrl,
    github_api_status: api.status_code || null,
    latency_ms: fallback.latency_ms,
    method_tested: fallback.method_tested,
    private_redirect_blocked: fallback.private_redirect_blocked || false,
    quality_signals: qualitySignals(
      { ...base, kind: "source-repo", public_safe: true },
      { ...fallback, classification },
    ),
    redirect_target: fallback.redirect_target,
    status: fallback.ok ? "ok" : "failed",
    status_code: fallback.status_code || null,
  };
}

async function verifyHttpSurface(base, candidate) {
  const accept = acceptHeader(candidate.kind);
  let probe = await probeUrl(candidate.url, "HEAD", accept);
  if (!probe.ok || [400, 403, 405].includes(probe.status_code)) {
    probe = await probeUrl(candidate.url, "GET", accept);
  }

  const classification = classifyHttpProbe(probe, candidate);
  return {
    ...base,
    classification,
    content_type: probe.content_type || null,
    error: probe.error || null,
    latency_ms: probe.latency_ms,
    method_tested: probe.method_tested,
    private_redirect_blocked: probe.private_redirect_blocked || false,
    redirect_target: probe.redirect_target,
    status: probe.ok ? "ok" : "failed",
    status_code: probe.status_code || null,
    confidence_score: scoreCandidate(candidate, { ...probe, classification }),
    quality_signals: qualitySignals(candidate, { ...probe, classification }),
  };
}

async function probeUrl(url, method, accept, redirectCount = 0) {
  if (await isUnsafeUrlResolved(url)) {
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
      if (await isUnsafeUrlResolved(redirectTarget)) {
        await response.body?.cancel();
        return {
          ok: false,
          error: "redirect target is unsafe",
          latency_ms: latencyMs,
          method_tested: method,
          private_redirect_blocked: true,
          redirect_target: redirectTarget,
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
        redirect_target: redirected.redirect_target || redirectTarget,
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
      error: error.message,
      error_class: error.name,
      latency_ms: Math.round(performance.now() - started),
      method_tested: method,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, headers = {}) {
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
      error: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function classifyHttpProbe(probe, candidate = null) {
  if (probe.unsafe_url || probe.private_redirect_blocked) {
    return "unsafe";
  }
  if (probe.error_class === "AbortError") {
    return "timeout";
  }
  if (
    probe.redirect_target &&
    probe.status_code >= 200 &&
    probe.status_code < 400
  ) {
    if (isContentMismatch(probe, candidate)) {
      return "content-mismatch";
    }
    return "redirected";
  }
  if (probe.status_code >= 200 && probe.status_code < 400) {
    if (isContentMismatch(probe, candidate)) {
      return "content-mismatch";
    }
    return "live";
  }
  if (probe.status_code === 429) {
    return "rate-limited";
  }
  if ([401, 403].includes(probe.status_code)) {
    return "auth-required";
  }
  if ([404, 410].includes(probe.status_code)) {
    return "dead";
  }
  if (probe.status_code >= 500) {
    return "transient";
  }
  return "unsupported";
}

function isPromotable(result) {
  return ["live", "redirected"].includes(result.classification);
}

function isContentMismatch(probe, candidate) {
  if (!candidate || !probe.ok) {
    return false;
  }
  if (candidate.kind === "openapi") {
    const pathname = new URL(candidate.url).pathname.toLowerCase();
    return pathname.endsWith(".json") && !isJsonContentType(probe.content_type);
  }
  if (candidate.kind === "sse") {
    return !String(probe.content_type || "")
      .toLowerCase()
      .includes("text/event-stream");
  }
  return false;
}

function scoreCandidate(candidate, probe) {
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

function qualitySignals(candidate, probe) {
  return {
    public_safe:
      candidate.public_safe === true &&
      !probe.unsafe_url &&
      !probe.private_redirect_blocked,
    source_tier: candidate.source_tier || null,
    content_type_matches_kind: !isContentMismatch(probe, candidate),
    redirected: Boolean(probe.redirect_target),
    rate_limited: probe.classification === "rate-limited",
    transient_failure: ["transient", "timeout"].includes(probe.classification),
  };
}

function acceptHeader(kind) {
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

function parseGithubRepo(value) {
  try {
    const url = new URL(value);
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

function githubHeaders() {
  if (!process.env.GITHUB_TOKEN) {
    return {};
  }
  return {
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    "x-github-api-version": "2022-11-28",
  };
}

function normalizeNullableUrl(value) {
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

async function mapLimit(items, limit, mapper) {
  const queue = [...items];
  const results = [];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift();
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

function countBy(items, key) {
  return Object.fromEntries(
    Object.entries(
      items.reduce((accumulator, item) => {
        accumulator[item[key]] = (accumulator[item[key]] || 0) + 1;
        return accumulator;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}
