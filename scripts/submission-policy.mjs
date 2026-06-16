import {
  clusterDomainFromUrl,
  flattenSurfaces,
  normalizePublicHttpUrl,
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
  endpointSubmission: "endpoint-submission",
  profileCorrection: "profile-correction",
  providerSubmission: "provider-submission",
  statusReport: "status-report",
};

const PROVIDER_KINDS = new Set([
  "infrastructure-provider",
  "subnet-team",
  "data-provider",
  "docs-provider",
  "registry",
]);

const STATUS_REPORT_TYPES = new Set([
  "down",
  "degraded",
  "stale",
  "wrong-auth-label",
  "wrong-rate-limit-label",
  "unsafe-or-private",
  "wrong-subnet",
  "other",
]);

const CANDIDATE_STATES = new Set([
  "schema-invalid",
  "schema-valid",
  "maintainer-review",
  "verified",
  "stale",
  "rejected",
]);

const CANDIDATE_SOURCE_TIERS = new Set([
  "native-chain",
  "provider-claimed",
  "third-party-index",
  "community-docs",
]);

const CANDIDATE_CONFIDENCE_LEVELS = new Set(["low", "medium", "high"]);

const CANDIDATE_VERIFICATION_CLASSIFICATIONS = new Set([
  "live",
  "redirected",
  "auth-required",
  "dead",
  "unsafe",
  "unsupported",
  "rate-limited",
  "transient",
  "timeout",
  "content-mismatch",
]);

const CANDIDATE_SCHEMA_FIELDS = new Set([
  "schema_version",
  "id",
  "netuid",
  "state",
  "name",
  "kind",
  "url",
  "source_url",
  "source_urls",
  "source_type",
  "source_tier",
  "confidence",
  "provider",
  "auth_required",
  "public_safe",
  "verification",
  "rate_limit_notes",
  "rate_limit",
  "review_notes",
]);

const REQUIRED_CANDIDATE_SCHEMA_FIELDS = [
  "schema_version",
  "id",
  "netuid",
  "state",
  "name",
  "kind",
  "url",
  "source_url",
  "provider",
  "auth_required",
  "public_safe",
];

export const PUBLIC_PREFLIGHT_STATES = new Set([
  "submit_pr",
  "fix_required",
  "route_away",
  "manual_review",
]);

export const DIRECT_CANDIDATE_PATTERN =
  /^registry\/candidates\/community\/[a-z0-9][a-z0-9-]*\.json$/;
export const DIRECT_PROVIDER_PATTERN =
  /^registry\/providers\/community\/[a-z0-9][a-z0-9-]*\.json$/;

export const SUPPORTED_INTERFACE_KINDS = new Set([
  "archive",
  "website",
  "source-repo",
  "subnet-api",
  "openapi",
  "sse",
  "sdk",
  "example",
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

const FIELD_PARSE_ERRORS = Symbol("metagraphed.issueFieldParseErrors");

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
  const fieldErrors = issueFieldParseErrors(fields);
  const labels = issueLabels(issue);
  if (labels.includes(SUBMISSION_LABELS.providerSubmission)) {
    return buildProviderProfileIntakeReport({
      fields,
      fieldErrors,
      generatedAt,
      issue,
      labels,
      providers,
    });
  }
  if (labels.includes(SUBMISSION_LABELS.statusReport)) {
    return buildEndpointStatusReportIntakeReport({
      fields,
      fieldErrors,
      generatedAt,
      issue,
      labels,
      native,
    });
  }
  const providerIds = new Set(providers.map((provider) => provider.id));
  const importApproved = labels.includes(SUBMISSION_LABELS.importApproved);
  const errors = [...fieldErrors];
  const manual_reasons = [];

  const netuid = Number(fields.netuid);
  if (
    !Number.isInteger(netuid) ||
    !native.subnets.some((subnet) => subnet.netuid === netuid)
  ) {
    errors.push("netuid must be an active Finney netuid");
  }

  const kind = normalizeKind(
    fields["interface kind"] || fields["endpoint kind"] || fields.kind,
  );
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
    fields["provider or team"] ||
      fields["provider or operator slug"] ||
      fields.provider ||
      "community",
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
  if (kind && ["archive", "subtensor-rpc", "subtensor-wss"].includes(kind)) {
    manual_reasons.push(
      "base-layer RPC/WSS/archive endpoint claims require review",
    );
  }

  const unsafeText = unsafeTextReasons(
    [
      fields["rate limits or access notes"],
      fields["public rate limits or access notes"],
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
          rate_limit_notes:
            fields["rate limits or access notes"] ||
            fields["public rate limits or access notes"] ||
            "",
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

export function buildProviderProfileIntakeReport({
  fields,
  fieldErrors = [],
  generatedAt = new Date().toISOString(),
  issue = null,
  labels = [],
  providers = [],
}) {
  const errors = [...fieldErrors];
  const manual_reasons = ["provider profile submissions require review"];
  const id = slugify(fields["provider slug"] || fields.provider_slug || "");
  const name = String(
    fields["provider name"] || fields.provider_name || "",
  ).trim();
  const kind = String(
    fields["provider kind"] || fields.provider_kind || "",
  ).trim();
  const websiteUrl = normalizePublicUrl(
    fields["website url"] || fields.website_url,
  );
  const docsUrl = normalizePublicUrl(fields["docs url"] || fields.docs_url);
  const githubUrl = normalizePublicUrl(
    fields["github org or repo url"] || fields.github_url,
  );
  const contactUrl = normalizePublicUrl(
    fields["public contact url"] || fields.contact_url,
  );
  const providerExists = providers.some((provider) => provider.id === id);

  if (!id)
    errors.push("provider slug is required and must be a lowercase slug");
  if (!name) errors.push("provider name is required");
  if (!PROVIDER_KINDS.has(kind)) errors.push("provider kind is unsupported");
  if (!websiteUrl) errors.push("website URL is missing, invalid, or unsafe");
  if ((fields["docs url"] || fields.docs_url) && !docsUrl) {
    errors.push("docs URL is invalid or unsafe");
  }
  if ((fields["github org or repo url"] || fields.github_url) && !githubUrl) {
    errors.push("GitHub URL is invalid or unsafe");
  }
  if ((fields["public contact url"] || fields.contact_url) && !contactUrl) {
    errors.push("public contact URL is invalid or unsafe");
  }
  errors.push(
    ...unsafeTextReasons(
      [
        fields["public notes"],
        fields.public_notes,
        fields["website url"],
        fields["docs url"],
        fields["github org or repo url"],
        fields["public contact url"],
      ].join("\n"),
    ).map((error) => error.message),
  );

  const schemaValid = errors.length === 0;
  return {
    schema_version: 1,
    generated_at: generatedAt,
    source: "github-provider-intake",
    issue: issueSummary(issue),
    state: schemaValid ? "schema-valid" : "schema-invalid",
    public_state: schemaValid ? "manual_review" : "fix_required",
    labels,
    errors,
    manual_reasons,
    provider: schemaValid
      ? {
          schema_version: 1,
          id,
          name,
          kind,
          website_url: websiteUrl,
          ...(docsUrl ? { docs_url: docsUrl } : {}),
          ...(githubUrl ? { github_url: githubUrl } : {}),
          ...(contactUrl ? { contact_url: contactUrl } : {}),
          authority: providerExists ? "provider-claimed" : "community",
          public_notes: fields["public notes"] || fields.public_notes || "",
        }
      : null,
    publish_allowed: false,
    import_allowed: false,
    review_marker: SUBMISSION_REVIEW_MARKER,
    next_action: schemaValid ? "manual-review" : "resubmission-needed",
  };
}

export function buildEndpointStatusReportIntakeReport({
  fields,
  fieldErrors = [],
  generatedAt = new Date().toISOString(),
  issue = null,
  labels = [],
  native,
}) {
  const errors = [...fieldErrors];
  const manual_reasons = [
    "status reports trigger review or re-probes and cannot set observed health",
  ];
  const netuid = Number(fields.netuid);
  const activeNetuid = native.subnets.some(
    (subnet) => subnet.netuid === netuid,
  );
  const surface = String(
    fields["surface id or url"] || fields.surface_id || "",
  ).trim();
  const issueType = String(
    fields["issue type"] || fields.issue_type || "",
  ).trim();
  const evidence = String(fields.evidence || "").trim();

  if (!Number.isInteger(netuid) || !activeNetuid) {
    errors.push("netuid must be an active Finney netuid");
  }
  if (!surface) {
    errors.push("surface ID or URL is required");
  } else if (surface.includes("://") && !normalizePublicUrl(surface)) {
    errors.push("surface URL is invalid or unsafe");
  }
  if (!STATUS_REPORT_TYPES.has(issueType)) {
    errors.push("issue type is unsupported");
  }
  if (!evidence) {
    errors.push("public evidence is required");
  }
  errors.push(
    ...unsafeTextReasons([surface, evidence].join("\n")).map(
      (error) => error.message,
    ),
  );

  const schemaValid = errors.length === 0;
  return {
    schema_version: 1,
    generated_at: generatedAt,
    source: "github-status-report-intake",
    issue: issueSummary(issue),
    state: schemaValid ? "schema-valid" : "schema-invalid",
    public_state: schemaValid ? "manual_review" : "fix_required",
    labels,
    errors,
    manual_reasons,
    report: schemaValid
      ? {
          schema_version: 1,
          netuid,
          surface,
          issue_type: issueType,
          evidence,
          source: "community-status-report",
          affects_observed_health: false,
          next_action: "review-or-reprobe",
        }
      : null,
    publish_allowed: false,
    import_allowed: false,
    review_marker: SUBMISSION_REVIEW_MARKER,
    next_action: schemaValid ? "manual-review" : "resubmission-needed",
  };
}

function issueSummary(issue) {
  return issue
    ? {
        number: issue.number || null,
        title: issue.title || null,
        author: issue.user?.login || null,
      }
    : null;
}

export function buildPrSubmissionReport({
  changedFiles,
  candidateDocument = null,
  providerDocument = null,
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
  let provider = null;

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
      provider: null,
      publish_allowed: false,
      auto_merge_eligible: false,
      blocking: false,
      review_marker: SUBMISSION_REVIEW_MARKER,
      next_action: "normal-review",
    };
  }

  if (errors.length === 0 && scope.scope === "direct-candidate") {
    const extracted = extractSingleCandidate(candidateDocument);
    errors.push(...extracted.errors);
    candidate = extracted.candidate;
  }

  if (errors.length === 0 && scope.scope === "direct-provider") {
    const extracted = extractSingleProvider(providerDocument);
    errors.push(...extracted.errors);
    provider = extracted.provider;
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

  if (provider) {
    const deterministic = validateProviderForSubmission({
      provider,
      document: providerDocument,
      submitter,
      providers,
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
    direct_provider_file: scope.providerFiles[0] || null,
    errors: errors.map((error) => error.message),
    error_categories: errors.map((error) => error.category),
    warnings,
    manual_reasons,
    candidate,
    provider,
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
  const providerFiles = files.filter((file) =>
    DIRECT_PROVIDER_PATTERN.test(file),
  );
  const touchedCommunityCandidate = files.filter((file) =>
    file.startsWith("registry/candidates/community/"),
  );
  const touchedCommunityProvider = files.filter((file) =>
    file.startsWith("registry/providers/community/"),
  );
  const errors = [];

  if (
    candidateFiles.length === 0 &&
    providerFiles.length === 0 &&
    touchedCommunityCandidate.length === 0 &&
    touchedCommunityProvider.length === 0
  ) {
    return {
      scope: "normal-pr",
      candidateFiles,
      providerFiles,
      errors,
    };
  }

  const submissionFileCount = candidateFiles.length + providerFiles.length;
  if (submissionFileCount !== 1) {
    errors.push({
      category: "unsupported-shape",
      message:
        "direct submissions must change exactly one registry/candidates/community/*.json or registry/providers/community/*.json file",
    });
  }

  const unrelated = files.filter(
    (file) =>
      !DIRECT_CANDIDATE_PATTERN.test(file) &&
      !DIRECT_PROVIDER_PATTERN.test(file),
  );
  if (unrelated.length > 0) {
    errors.push({
      category: "generated-artifact-tampering",
      message: `direct submissions cannot change other files: ${unrelated.join(", ")}`,
    });
  }

  return {
    scope: providerFiles.length === 1 ? "direct-provider" : "direct-candidate",
    candidateFiles,
    providerFiles,
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

export function extractSingleProvider(document) {
  const errors = [];
  if (!document || typeof document !== "object") {
    return {
      provider: null,
      errors: [
        {
          category: "unsupported-shape",
          message: "provider submission document must be a JSON object",
        },
      ],
    };
  }

  if (document.schema_version !== 1) {
    errors.push({
      category: "unsupported-shape",
      message: "provider submission document schema_version must be 1",
    });
  }
  if (!document.provider || typeof document.provider !== "object") {
    errors.push({
      category: "unsupported-shape",
      message: "provider submission document must include provider",
    });
  }

  return {
    provider: document.provider || null,
    errors,
  };
}

function validateCandidateSchemaShape(candidate) {
  const errors = [];

  for (const field of REQUIRED_CANDIDATE_SCHEMA_FIELDS) {
    if (candidate[field] === undefined) {
      errors.push({
        category: "unsupported-shape",
        message: `candidate ${field} is required`,
      });
    }
  }

  for (const field of Object.keys(candidate)) {
    if (!CANDIDATE_SCHEMA_FIELDS.has(field)) {
      errors.push({
        category: "unsupported-shape",
        message: `candidate ${field} is not allowed`,
      });
    }
  }

  if (candidate.state !== undefined && !CANDIDATE_STATES.has(candidate.state)) {
    errors.push({
      category: "unsupported-shape",
      message: "candidate state is unsupported",
    });
  }
  if (
    candidate.name !== undefined &&
    (typeof candidate.name !== "string" || candidate.name.length === 0)
  ) {
    errors.push({
      category: "unsupported-shape",
      message: "candidate name is required",
    });
  }
  if (
    candidate.auth_required !== undefined &&
    typeof candidate.auth_required !== "boolean"
  ) {
    errors.push({
      category: "unsupported-shape",
      message: "candidate auth_required must be boolean",
    });
  }
  if (
    candidate.public_safe !== undefined &&
    typeof candidate.public_safe !== "boolean"
  ) {
    errors.push({
      category: "unsupported-shape",
      message: "candidate public_safe must be boolean",
    });
  }
  if (
    candidate.source_tier !== undefined &&
    !CANDIDATE_SOURCE_TIERS.has(candidate.source_tier)
  ) {
    errors.push({
      category: "unsupported-shape",
      message: "candidate source_tier is unsupported",
    });
  }
  if (
    candidate.confidence !== undefined &&
    !CANDIDATE_CONFIDENCE_LEVELS.has(candidate.confidence)
  ) {
    errors.push({
      category: "unsupported-shape",
      message: "candidate confidence is unsupported",
    });
  }
  if (
    candidate.source_type !== undefined &&
    typeof candidate.source_type !== "string"
  ) {
    errors.push({
      category: "unsupported-shape",
      message: "candidate source_type must be a string",
    });
  }
  if (candidate.rate_limit !== undefined) {
    if (
      !candidate.rate_limit ||
      typeof candidate.rate_limit !== "object" ||
      Array.isArray(candidate.rate_limit)
    ) {
      errors.push({
        category: "unsupported-shape",
        message: "candidate rate_limit must be an object",
      });
    } else {
      const allowedRateLimitFields = new Set([
        "requests",
        "window",
        "burst",
        "scope",
        "cost_notes",
      ]);
      for (const field of ["requests", "window"]) {
        if (candidate.rate_limit[field] === undefined) {
          errors.push({
            category: "unsupported-shape",
            message: `candidate rate_limit.${field} is required`,
          });
        }
      }
      for (const field of Object.keys(candidate.rate_limit)) {
        if (!allowedRateLimitFields.has(field)) {
          errors.push({
            category: "unsupported-shape",
            message: `candidate rate_limit.${field} is not allowed`,
          });
        }
      }
      for (const field of ["requests", "burst"]) {
        if (
          candidate.rate_limit[field] !== undefined &&
          (!Number.isInteger(candidate.rate_limit[field]) ||
            candidate.rate_limit[field] < 0)
        ) {
          errors.push({
            category: "unsupported-shape",
            message: `candidate rate_limit.${field} must be a non-negative integer`,
          });
        }
      }
      if (
        candidate.rate_limit.window !== undefined &&
        (typeof candidate.rate_limit.window !== "string" ||
          candidate.rate_limit.window.length === 0)
      ) {
        errors.push({
          category: "unsupported-shape",
          message: "candidate rate_limit.window is required",
        });
      }
      if (
        candidate.rate_limit.scope !== undefined &&
        !["per-key", "per-ip", "global", "unknown"].includes(
          candidate.rate_limit.scope,
        )
      ) {
        errors.push({
          category: "unsupported-shape",
          message: "candidate rate_limit.scope is unsupported",
        });
      }
      if (
        candidate.rate_limit.cost_notes !== undefined &&
        typeof candidate.rate_limit.cost_notes !== "string"
      ) {
        errors.push({
          category: "unsupported-shape",
          message: "candidate rate_limit.cost_notes must be a string",
        });
      }
    }
  }

  for (const field of ["rate_limit_notes", "review_notes"]) {
    if (
      candidate[field] !== undefined &&
      typeof candidate[field] !== "string"
    ) {
      errors.push({
        category: "unsupported-shape",
        message: `candidate ${field} must be a string`,
      });
    }
  }
  if (candidate.verification !== undefined && candidate.verification !== null) {
    if (
      typeof candidate.verification !== "object" ||
      Array.isArray(candidate.verification)
    ) {
      errors.push({
        category: "unsupported-shape",
        message: "candidate verification must be an object",
      });
    } else {
      if (
        !CANDIDATE_VERIFICATION_CLASSIFICATIONS.has(
          candidate.verification.classification,
        )
      ) {
        errors.push({
          category: "unsupported-shape",
          message: "candidate verification classification is unsupported",
        });
      }
      if (typeof candidate.verification.verified_at !== "string") {
        errors.push({
          category: "unsupported-shape",
          message: "candidate verification verified_at must be a string",
        });
      }
    }
  }

  return errors;
}

// Ownership-sensitive kinds purport to be the subnet's OWN first-party surface, so the URL owner must
// plausibly belong to the registered provider. Third-party/aggregator kinds (dashboard/docs/etc.)
// legitimately have a different owner and are not owner-checked here.
const OWNER_SENSITIVE_KINDS = new Set([
  "source-repo",
  "website",
  "subnet-api",
  "openapi",
  "sse",
]);
const CODE_HOST_RE = /^(github\.com|gitlab\.com|bitbucket\.org)$/i;
const normIdentToken = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Owner token(s) a URL claims — a code host (github/gitlab/bitbucket) contributes its ORG; any other
 *  host contributes its registrable-domain label. Normalized to alnum, ≥4 chars (a 1-3 char slug
 *  matches anywhere). */
export function urlOwnerTokens(value) {
  if (typeof value !== "string" || !value) return [];
  let url;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const out = [];
  if (CODE_HOST_RE.test(host)) {
    const org = url.pathname.replace(/^\/+/, "").split("/")[0];
    if (org) out.push(normIdentToken(org));
  } else {
    const domain = clusterDomainFromUrl(value);
    if (domain) out.push(normIdentToken(domain.split(".")[0]));
  }
  return out.filter((token) => token.length >= 4);
}

/** Identity tokens for a candidate's declared provider — its name, id, and the owner tokens of its
 *  official website/docs/github. Used to check an ownership-sensitive candidate's URL belongs to it. */
export function providerIdentityTokens(provider) {
  if (!provider || typeof provider !== "object") return [];
  const out = new Set();
  for (const field of ["name", "id"]) {
    const token = normIdentToken(provider[field]);
    if (token.length >= 4) out.add(token);
  }
  for (const field of ["website_url", "docs_url", "github_url"]) {
    for (const token of urlOwnerTokens(provider[field])) out.add(token);
  }
  return [...out];
}

/** Two identity tokens are "related" — EXACTLY equal, or one contains the other with the shorter
 *  (discriminating) token ≥8 chars, so a short generic/forgeable token (sn76, vision, data, network)
 *  can only match by exact equality, never by being a substring of an attacker org. (adversarial) */
export function ownerTokensRelated(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 8 && longer.includes(shorter);
}

/** github org "luminarnetwork" matches provider name token "luminarnetwork" (exact); "safescanai" does
 *  not match "byzantium". Empty token set → can't determine → don't block. */
export function ownerTokensMatch(claimTokens, identityTokens) {
  if (claimTokens.length === 0 || identityTokens.length === 0) return true;
  return claimTokens.some((claim) =>
    identityTokens.some((identity) => ownerTokensRelated(claim, identity)),
  );
}

/** True when two URLs are the same resource ignoring scheme + www + trailing slash — so http↔https and
 *  www↔apex variants of one url do not read as an "independent" proof source. (adversarial) */
export function sameResourceUrl(a, b) {
  const canon = (value) => {
    try {
      const url = new URL(value);
      return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`.toLowerCase();
    } catch {
      return null;
    }
  };
  const left = canon(a);
  const right = canon(b);
  return left != null && left === right;
}

/** Anchored placeholder/example-URL detection — avoids substring false-positives (notexample.com,
 *  example.company.com, "/deprecated-endpoints"). Flags example.com/.org/.net as the registrable host,
 *  the github username/repo stub, or "deprecated" as a whole host/path label. (adversarial) */
export function isPlaceholderUrl(value) {
  if (typeof value !== "string" || !value) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (
    ["com", "org", "net"].some(
      (tld) => host === `example.${tld}` || host.endsWith(`.example.${tld}`),
    )
  ) {
    return true;
  }
  const segments = url.pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
  if (
    /^(github|gitlab)\.com$/.test(host) &&
    segments[0] === "username" &&
    (segments[1] || "").replace(/\.git$/i, "") === "repo"
  ) {
    return true;
  }
  if (
    host === "deprecated" ||
    segments.some((s) => s.toLowerCase() === "deprecated")
  ) {
    return true;
  }
  return false;
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

  errors.push(...validateCandidateSchemaShape(candidate));

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
  if (candidate.source_urls !== undefined) {
    if (!Array.isArray(candidate.source_urls)) {
      errors.push({
        category: "unsupported-shape",
        message: "candidate source_urls must be an array",
      });
    } else {
      for (const [index, sourceUrl] of candidate.source_urls.entries()) {
        const normalizedProvenanceUrl = normalizePublicUrl(sourceUrl);
        if (!normalizedProvenanceUrl) {
          errors.push({
            category: "private-or-unsafe-url",
            message: `candidate source_urls[${index}] is invalid or unsafe`,
          });
        } else if (sourceUrl !== normalizedProvenanceUrl) {
          warnings.push(
            `candidate source_urls[${index}] will be normalized by registry tooling`,
          );
        }
      }
    }
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
  // Placeholder/example identity URLs (example.com, github.com/username/repo, "deprecated") are never
  // a real surface — reject rather than feed the review gate a fake. (hardening preflight)
  if (isPlaceholderUrl(candidate.url)) {
    errors.push({
      category: "private-or-unsafe-url",
      message: "candidate url is a placeholder/example URL",
    });
  }
  if (isPlaceholderUrl(candidate.source_url)) {
    errors.push({
      category: "private-or-unsafe-url",
      message: "candidate source_url is a placeholder/example URL",
    });
  }
  // Ownership-sensitive surfaces must be the subnet's OWN: the URL owner (code org / domain) must
  // plausibly match the registered provider's identity, and — for non-repo kinds — the proof source
  // must be INDEPENDENT of the url. Mismatches route to maintainer review: a deterministic pre-filter
  // that reinforces the private review gate's owner-match in depth (identity facts, no scoring rubric).
  if (OWNER_SENSITIVE_KINDS.has(candidate.kind)) {
    const providerRecord = providers.find(
      (provider) => provider.id === candidate.provider,
    );
    const identityTokens = providerIdentityTokens(providerRecord);
    const claimTokens = urlOwnerTokens(candidate.url);
    if (!ownerTokensMatch(claimTokens, identityTokens)) {
      manual_reasons.push(
        "candidate url owner does not match its registered provider's identity — needs review to confirm it is the subnet's own surface",
      );
    }
    if (
      candidate.kind !== "source-repo" &&
      normalizedUrl &&
      normalizedSourceUrl &&
      sameResourceUrl(candidate.url, candidate.source_url)
    ) {
      manual_reasons.push(
        "candidate source_url is identical to its url — an independent proof source is needed for this kind",
      );
    }
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
  if (["archive", "subtensor-rpc", "subtensor-wss"].includes(candidate.kind)) {
    manual_reasons.push(
      "base-layer RPC/WSS/archive endpoint claims require review",
    );
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

export function validateProviderForSubmission({
  provider,
  document = {},
  submitter = null,
  providers,
}) {
  const errors = [];
  const warnings = [];
  const manual_reasons = ["provider profile submissions require review"];
  const providerIds = new Set(providers.map((entry) => entry.id));
  const websiteUrl = normalizePublicUrl(provider?.website_url);
  const docsUrl = normalizePublicUrl(provider?.docs_url);
  const githubUrl = normalizePublicUrl(provider?.github_url);
  const teamUrl = normalizePublicUrl(provider?.team_url);
  const contactUrl = normalizePublicUrl(provider?.contact_url);
  const logoUrl = normalizePublicHttpUrl(provider?.logo_url);
  const socialEntries =
    provider?.social &&
    typeof provider.social === "object" &&
    !Array.isArray(provider.social)
      ? Object.entries(provider.social)
      : [];

  if (!provider || typeof provider !== "object") {
    return {
      errors: [
        {
          category: "unsupported-shape",
          message: "provider is required",
        },
      ],
      warnings,
      manual_reasons,
    };
  }

  if (provider.schema_version !== 1) {
    errors.push({
      category: "unsupported-shape",
      message: "provider schema_version must be 1",
    });
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(provider.id || "")) {
    errors.push({
      category: "unsupported-shape",
      message: "provider id must be a lowercase slug",
    });
  }
  if (!String(provider.name || "").trim()) {
    errors.push({
      category: "unsupported-shape",
      message: "provider name is required",
    });
  }
  if (!PROVIDER_KINDS.has(provider.kind)) {
    errors.push({
      category: "unsupported-shape",
      message: "provider kind is unsupported",
    });
  }
  if (!websiteUrl) {
    errors.push({
      category: "private-or-unsafe-url",
      message: "provider website_url is missing, invalid, or unsafe",
    });
  }
  for (const [field, normalized] of [
    ["docs_url", docsUrl],
    ["github_url", githubUrl],
    ["team_url", teamUrl],
    ["contact_url", contactUrl],
    ["logo_url", logoUrl],
  ]) {
    if (provider[field] && !normalized) {
      errors.push({
        category: "private-or-unsafe-url",
        message: `provider ${field} is invalid or unsafe`,
      });
    } else if (provider[field] && provider[field] !== normalized) {
      warnings.push(`provider ${field} will be normalized by registry tooling`);
    }
  }
  for (const [key, value] of socialEntries) {
    const normalized = normalizePublicHttpUrl(value);
    if (!normalized) {
      errors.push({
        category: "private-or-unsafe-url",
        message: `provider social.${key} is invalid or unsafe`,
      });
    } else if (value !== normalized) {
      warnings.push(
        `provider social.${key} will be normalized by registry tooling`,
      );
    }
  }
  if (!["community", "provider-claimed"].includes(provider.authority)) {
    errors.push({
      category: "unsupported-shape",
      message:
        "community provider submissions can only use community or provider-claimed authority",
    });
  }
  if (provider.notes !== undefined) {
    errors.push({
      category: "unsupported-shape",
      message:
        "community provider submissions must use public_notes, not notes",
    });
  }
  if (provider.id && providerIds.has(provider.id)) {
    manual_reasons.push("existing provider profile updates require review");
  }

  errors.push(...unsafeTextReasons(JSON.stringify(provider)));
  errors.push(
    ...validateSubmissionProvenance({
      document,
      submitter,
    }),
  );

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
  const errors = [];
  const sanitizedBody = String(body || "").replace(
    /<!--[\s\S]*?(?:-->|$)/g,
    "",
  );
  const sections = sanitizedBody.split(/^###\s+/m).slice(1);
  for (const section of sections) {
    const [heading, ...rest] = section.split(/\r?\n/);
    const key = heading.trim().toLowerCase();
    if (Object.hasOwn(fields, key)) {
      errors.push(`duplicate issue field heading: ${heading.trim()}`);
      continue;
    }
    const value = rest
      .join("\n")
      .trim()
      .replace(/^_No response_$/i, "");
    fields[key] = value;
  }
  Object.defineProperty(fields, FIELD_PARSE_ERRORS, {
    value: errors,
    enumerable: false,
  });
  return fields;
}

export function issueFieldParseErrors(fields) {
  return fields?.[FIELD_PARSE_ERRORS] || [];
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
