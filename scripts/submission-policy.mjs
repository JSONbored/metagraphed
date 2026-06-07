import {
  flattenSurfaces,
  normalizePublicUrl,
  registrySurfaceKey,
  slugify,
} from "./lib.mjs";

export const SUBMISSION_REVIEW_MARKER = "<!-- metagraphed-submission-gate -->";

export const SUBMISSION_LABELS = {
  underReview: "metagraphed-under-review",
  manualReview: "metagraphed-manual-review",
  closedByGate: "metagraphed-closed-by-gate",
  mergedByGate: "metagraphed-merged-by-gate",
  importApproved: "metagraphed-import-approved",
  interfaceSubmission: "interface-submission",
  statusReport: "status-report",
};

export const PUBLIC_PREFLIGHT_STATES = new Set([
  "submit_pr",
  "fix_required",
  "route_away",
  "manual_review",
]);

export const DIRECT_CANDIDATE_PATTERN =
  /^registry\/candidates\/community\/[a-z0-9][a-z0-9-]*\.json$/;

export const SUPPORTED_INTERFACE_KINDS = new Set([
  "website",
  "source-repo",
  "subnet-api",
  "openapi",
  "sse",
  "dashboard",
  "repo-registry",
  "docs",
  "data-artifact",
  "subtensor-rpc",
  "subtensor-wss",
]);

const TERMINAL_FIX_CATEGORIES = new Set([
  "duplicate",
  "generated-artifact-tampering",
  "private-or-unsafe-url",
  "secret-or-credential",
  "unsupported-shape",
]);

const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\b[A-Za-z0-9+/]{32,}={0,2}\b.*\b(secret|token|pat|wallet|private key)\b/i,
  /\b(private[_-]?key|seed phrase|mnemonic|wallet path|hotkey|coldkey)\b/i,
];

export function buildIssueIntakeReport({
  issue,
  native,
  providers,
  generatedAt = new Date().toISOString(),
}) {
  const fields = parseIssueFields(issue?.body || "");
  const labels = issueLabels(issue);
  const providerIds = new Set(providers.map((provider) => provider.id));
  const importApproved = labels.includes(SUBMISSION_LABELS.importApproved);
  const errors = [];
  const manual_reasons = [];

  const netuid = Number(fields.netuid);
  if (
    !Number.isInteger(netuid) ||
    !native.subnets.some((subnet) => subnet.netuid === netuid)
  ) {
    errors.push("netuid must be an active Finney netuid");
  }

  const kind = normalizeKind(fields["interface kind"] || fields.kind);
  if (!kind) {
    errors.push("interface kind is missing or unsupported");
  }

  const url = normalizePublicUrl(fields["public url"] || fields.url);
  if (!url) {
    errors.push("public URL is missing, invalid, or unsafe");
  }

  const sourceUrl = normalizePublicUrl(
    fields["source url"] || fields.source_url,
  );
  if (!sourceUrl) {
    errors.push("source URL is missing, invalid, or unsafe");
  }

  const provider = slugify(
    fields["provider or team"] || fields.provider || "community",
  );
  if (provider && !providerIds.has(provider)) {
    errors.push(`provider ${provider} is not registered in registry/providers`);
  }

  const auth = normalizeAuth(
    fields["does this interface require authentication?"] ||
      fields.auth_required,
  );
  if (auth.value === null) {
    errors.push("auth_required must be no, yes, or unknown");
  }
  if (auth.manualReason) {
    manual_reasons.push(auth.manualReason);
  }
  if (kind && ["subtensor-rpc", "subtensor-wss"].includes(kind)) {
    manual_reasons.push("base-layer RPC/WSS endpoint claims require review");
  }

  const unsafeText = unsafeTextReasons(
    [
      fields["rate limits or access notes"],
      fields.evidence,
      fields["public url"],
      fields["source url"],
    ].join("\n"),
  );
  errors.push(...unsafeText);

  const subnet = native.subnets.find(
    (candidate) => candidate.netuid === netuid,
  );
  const id =
    errors.length === 0
      ? `community-sn-${netuid}-${kind}-${slugify(new URL(url).hostname)}`
      : null;
  const candidate =
    errors.length === 0
      ? {
          schema_version: 1,
          id,
          netuid,
          state:
            manual_reasons.length > 0 ? "maintainer-review" : "schema-valid",
          name: `${subnet.name} community ${kind}`,
          kind,
          url,
          source_url: sourceUrl,
          source_urls: [sourceUrl],
          source_type: "github-issue-intake",
          source_tier: "community-docs",
          confidence: manual_reasons.length > 0 ? "low" : "medium",
          provider,
          auth_required: auth.value === true,
          public_safe: true,
          rate_limit_notes: fields["rate limits or access notes"] || "",
          review_notes: [
            `Community-submitted candidate from issue ${issue?.number || "unknown"}.`,
            manual_reasons.length > 0
              ? `Manual review reasons: ${manual_reasons.join("; ")}.`
              : "Ready for private review.",
          ].join(" "),
        }
      : null;

  const schemaValid = errors.length === 0;
  return {
    schema_version: 1,
    generated_at: generatedAt,
    source: "github-issue-intake",
    issue: issue
      ? {
          number: issue.number || null,
          title: issue.title || null,
          author: issue.user?.login || null,
        }
      : null,
    state: schemaValid ? "schema-valid" : "schema-invalid",
    public_state: !schemaValid
      ? "fix_required"
      : manual_reasons.length > 0
        ? "manual_review"
        : "submit_pr",
    labels,
    errors,
    manual_reasons,
    candidate,
    publish_allowed: false,
    import_allowed: schemaValid && importApproved,
    approval_required_label: SUBMISSION_LABELS.importApproved,
    review_marker: SUBMISSION_REVIEW_MARKER,
    next_action: !schemaValid
      ? "resubmission-needed"
      : importApproved
        ? "open-import-pr"
        : manual_reasons.length > 0
          ? "manual-review"
          : "private-review",
  };
}

export function buildPrSubmissionReport({
  changedFiles,
  candidateDocument = null,
  submitter = null,
  native,
  providers,
  existingCandidates = [],
  existingSubnets = [],
  generatedAt = new Date().toISOString(),
}) {
  const normalizedFiles = normalizeChangedFiles(changedFiles);
  const scope = classifyPrScope(normalizedFiles);
  const errors = [...scope.errors];
  const manual_reasons = [];
  const warnings = [];
  let candidate = null;

  if (scope.scope === "normal-pr") {
    return {
      schema_version: 1,
      generated_at: generatedAt,
      source: "github-pr-intake",
      state: "not-routed",
      public_state: "route_away",
      changed_files: normalizedFiles,
      errors: [],
      warnings: [],
      manual_reasons: [],
      candidate: null,
      publish_allowed: false,
      auto_merge_eligible: false,
      blocking: false,
      review_marker: SUBMISSION_REVIEW_MARKER,
      next_action: "normal-review",
    };
  }

  if (errors.length === 0) {
    const extracted = extractSingleCandidate(candidateDocument);
    errors.push(...extracted.errors);
    candidate = extracted.candidate;
  }

  if (candidate) {
    const deterministic = validateCandidateForSubmission({
      candidate,
      document: candidateDocument,
      submitter,
      native,
      providers,
      existingCandidates,
      existingSubnets,
    });
    errors.push(...deterministic.errors);
    manual_reasons.push(...deterministic.manual_reasons);
    warnings.push(...deterministic.warnings);
  }

  const publicState =
    errors.length > 0
      ? "fix_required"
      : manual_reasons.length > 0
        ? "manual_review"
        : "submit_pr";
  const terminalRecommendation = errors.some((error) =>
    TERMINAL_FIX_CATEGORIES.has(error.category),
  )
    ? "close"
    : null;

  return {
    schema_version: 1,
    generated_at: generatedAt,
    source: "github-pr-intake",
    state: errors.length === 0 ? "schema-valid" : "schema-invalid",
    public_state: publicState,
    changed_files: normalizedFiles,
    direct_candidate_file: scope.candidateFiles[0] || null,
    errors: errors.map((error) => error.message),
    error_categories: errors.map((error) => error.category),
    warnings,
    manual_reasons,
    candidate,
    publish_allowed: false,
    auto_merge_eligible: false,
    private_review_required:
      publicState === "submit_pr" || publicState === "manual_review",
    blocking: publicState === "fix_required",
    terminal_recommendation: terminalRecommendation,
    review_marker: SUBMISSION_REVIEW_MARKER,
    labels: {
      under_review: SUBMISSION_LABELS.underReview,
      manual_review: SUBMISSION_LABELS.manualReview,
      closed_by_gate: SUBMISSION_LABELS.closedByGate,
      merged_by_gate: SUBMISSION_LABELS.mergedByGate,
    },
    next_action:
      publicState === "submit_pr"
        ? "private-review"
        : publicState === "manual_review"
          ? "manual-review"
          : terminalRecommendation || "resubmission-needed",
  };
}

export function classifyPrScope(changedFiles) {
  const files = normalizeChangedFiles(changedFiles);
  const candidateFiles = files.filter((file) =>
    DIRECT_CANDIDATE_PATTERN.test(file),
  );
  const touchedCommunityCandidate = files.filter((file) =>
    file.startsWith("registry/candidates/community/"),
  );
  const errors = [];

  if (candidateFiles.length === 0 && touchedCommunityCandidate.length === 0) {
    return {
      scope: "normal-pr",
      candidateFiles,
      errors,
    };
  }

  if (candidateFiles.length !== 1) {
    errors.push({
      category: "unsupported-shape",
      message:
        "direct submissions must change exactly one registry/candidates/community/*.json file",
    });
  }

  const unrelated = files.filter(
    (file) => !DIRECT_CANDIDATE_PATTERN.test(file),
  );
  if (unrelated.length > 0) {
    errors.push({
      category: "generated-artifact-tampering",
      message: `direct submissions cannot change other files: ${unrelated.join(", ")}`,
    });
  }

  return {
    scope: "direct-candidate",
    candidateFiles,
    errors,
  };
}

export function extractSingleCandidate(document) {
  const errors = [];
  if (!document || typeof document !== "object") {
    return {
      candidate: null,
      errors: [
        {
          category: "unsupported-shape",
          message: "candidate document must be a JSON object",
        },
      ],
    };
  }

  if (document.schema_version !== 1) {
    errors.push({
      category: "unsupported-shape",
      message: "candidate document schema_version must be 1",
    });
  }
  if (!Array.isArray(document.candidates) || document.candidates.length !== 1) {
    errors.push({
      category: "unsupported-shape",
      message: "candidate document must contain exactly one candidate",
    });
  }

  return {
    candidate: document.candidates?.[0] || null,
    errors,
  };
}

export function validateCandidateForSubmission({
  candidate,
  document = {},
  submitter = null,
  native,
  providers,
  existingCandidates = [],
  existingSubnets = [],
}) {
  const errors = [];
  const warnings = [];
  const manual_reasons = [];
  const nativeNetuids = new Set(native.subnets.map((subnet) => subnet.netuid));
  const providerIds = new Set(providers.map((provider) => provider.id));
  const normalizedUrl = normalizePublicUrl(candidate?.url);
  const normalizedSourceUrl = normalizePublicUrl(candidate?.source_url);

  if (!candidate || typeof candidate !== "object") {
    return {
      errors: [
        {
          category: "unsupported-shape",
          message: "candidate is required",
        },
      ],
      warnings,
      manual_reasons,
    };
  }

  if (candidate.schema_version !== 1) {
    errors.push({
      category: "unsupported-shape",
      message: "candidate schema_version must be 1",
    });
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(candidate.id || "")) {
    errors.push({
      category: "unsupported-shape",
      message: "candidate id must be a lowercase slug",
    });
  }
  if (
    !Number.isInteger(candidate.netuid) ||
    !nativeNetuids.has(candidate.netuid)
  ) {
    errors.push({
      category: "unsupported-shape",
      message: "candidate netuid must be an active Finney netuid",
    });
  }
  if (!SUPPORTED_INTERFACE_KINDS.has(candidate.kind)) {
    errors.push({
      category: "unsupported-shape",
      message: "candidate kind is unsupported",
    });
  }
  if (!normalizedUrl) {
    errors.push({
      category: "private-or-unsafe-url",
      message: "candidate url is missing, invalid, or unsafe",
    });
  }
  if (!normalizedSourceUrl) {
    errors.push({
      category: "private-or-unsafe-url",
      message: "candidate source_url is missing, invalid, or unsafe",
    });
  }
  if (candidate.url && normalizedUrl && candidate.url !== normalizedUrl) {
    warnings.push("candidate url will be normalized by registry tooling");
  }
  if (
    candidate.source_url &&
    normalizedSourceUrl &&
    candidate.source_url !== normalizedSourceUrl
  ) {
    warnings.push(
      "candidate source_url will be normalized by registry tooling",
    );
  }
  if (!providerIds.has(candidate.provider)) {
    errors.push({
      category: "unsupported-shape",
      message: `candidate provider ${candidate.provider || "<missing>"} is not registered`,
    });
  }
  if (candidate.public_safe !== true) {
    errors.push({
      category: "private-or-unsafe-url",
      message: "candidate public_safe must be true for community submissions",
    });
  }
  if (candidate.state && candidate.state !== "schema-valid") {
    manual_reasons.push(`candidate state ${candidate.state} requires review`);
  }
  if (candidate.auth_required === true) {
    manual_reasons.push("authenticated interfaces require review");
  }
  if (["subtensor-rpc", "subtensor-wss"].includes(candidate.kind)) {
    manual_reasons.push("base-layer RPC/WSS endpoint claims require review");
  }
  if (candidate.source_tier === "native-chain") {
    errors.push({
      category: "unsupported-shape",
      message: "community candidates cannot claim native-chain source tier",
    });
  }
  if (
    candidate.source_type &&
    !["community-pr-intake", "github-issue-intake"].includes(
      candidate.source_type,
    )
  ) {
    warnings.push(
      "candidate source_type is not a standard community intake type",
    );
  }

  errors.push(...unsafeTextReasons(JSON.stringify(candidate)));
  errors.push(
    ...validateSubmissionProvenance({
      document,
      submitter,
    }),
  );

  if (normalizedUrl && candidate.kind && Number.isInteger(candidate.netuid)) {
    const locator = registrySurfaceKey({
      netuid: candidate.netuid,
      kind: candidate.kind,
      url: normalizedUrl,
    });
    const surfaces = flattenSurfaces(existingSubnets || []);
    const surfaceDuplicate = surfaces.find(
      (surface) => registrySurfaceKey(surface) === locator,
    );
    if (surfaceDuplicate) {
      errors.push({
        category: "duplicate",
        message: `candidate duplicates curated surface ${surfaceDuplicate.id}`,
      });
    }

    const candidateDuplicate = existingCandidates.find(
      (existing) =>
        existing.id !== candidate.id &&
        registrySurfaceKey(existing) === locator,
    );
    if (candidateDuplicate) {
      errors.push({
        category: "duplicate",
        message: `candidate duplicates existing candidate ${candidateDuplicate.id}`,
      });
    }
  }

  return { errors, warnings, manual_reasons };
}

export function normalizeChangedFiles(files) {
  if (typeof files === "string") {
    return files
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean)
      .map(normalizeChangedFilePath)
      .sort();
  }
  return [...new Set((files || []).map((file) => String(file).trim()))]
    .filter(Boolean)
    .map(normalizeChangedFilePath)
    .sort();
}

function normalizeChangedFilePath(file) {
  return file.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function parseIssueFields(body) {
  const fields = {};
  const sections = String(body || "")
    .split(/^###\s+/m)
    .slice(1);
  for (const section of sections) {
    const [heading, ...rest] = section.split(/\r?\n/);
    const key = heading.trim().toLowerCase();
    const value = rest
      .join("\n")
      .trim()
      .replace(/^_No response_$/i, "");
    fields[key] = value;
  }
  return fields;
}

export function normalizeKind(value) {
  const normalized = String(value || "").trim();
  return SUPPORTED_INTERFACE_KINDS.has(normalized) ? normalized : null;
}

export function normalizeAuth(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "no") return { value: false, manualReason: null };
  if (normalized === "yes") {
    return {
      value: true,
      manualReason: "authenticated interfaces require review",
    };
  }
  if (normalized === "unknown") {
    return {
      value: false,
      manualReason: "unknown auth requirements require review",
    };
  }
  return { value: null, manualReason: null };
}

export function issueLabels(issue) {
  return (issue?.labels || [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean)
    .sort();
}

export function validateSubmissionProvenance({ document, submitter }) {
  const errors = [];
  const provenance = document?.submission || {};
  const normalizedSubmitter = normalizeGitHubLogin(submitter);
  const submittedBy = normalizeGitHubLogin(provenance.submitted_by);
  const submittedByUrl = String(provenance.submitted_by_url || "").trim();

  if (!normalizedSubmitter) {
    errors.push({
      category: "unsupported-shape",
      message: "submitter is required for direct candidate PR validation",
    });
  }
  if (!submittedBy) {
    errors.push({
      category: "unsupported-shape",
      message: "candidate document must include submission.submitted_by",
    });
  }
  if (
    normalizedSubmitter &&
    submittedBy &&
    normalizedSubmitter !== submittedBy
  ) {
    errors.push({
      category: "unsupported-shape",
      message: "submission.submitted_by must match the PR author",
    });
  }
  if (submittedBy && submittedByUrl !== `https://github.com/${submittedBy}`) {
    errors.push({
      category: "unsupported-shape",
      message: "submission.submitted_by_url must match submitted_by",
    });
  }

  return errors;
}

export function normalizeGitHubLogin(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function unsafeTextReasons(text) {
  const value = String(text || "");
  return SECRET_PATTERNS.filter((pattern) => pattern.test(value)).map(() => ({
    category: "secret-or-credential",
    message:
      "submission appears to include wallet, PAT, token, or private credential material",
  }));
}
