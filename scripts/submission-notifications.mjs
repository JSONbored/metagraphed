export const SUBMISSION_REVIEW_MARKER = "<!-- metagraphed-submission-gate -->";

export const TERMINAL_NOTIFICATION_VERDICTS = new Set([
  "merged",
  "closed",
  "manual-review",
  "retry-exhausted",
]);

export const NON_TERMINAL_NOTIFICATION_STATES = new Set([
  "route_away",
  "submit_pr",
  "fix_required",
]);

const DISCORD_MAX_TITLE_LENGTH = 256;
const DISCORD_MAX_DESCRIPTION_LENGTH = 320;
const DISCORD_MAX_FIELD_LENGTH = 220;

const VERDICT_META = {
  merged: {
    action: "merged",
    label: "Merged",
    color: 0x238636,
  },
  closed: {
    action: "closed",
    label: "Closed",
    color: 0xda3633,
  },
  "manual-review": {
    action: "needs review",
    label: "Manual review",
    color: 0x8957e5,
  },
  "retry-exhausted": {
    action: "needs attention",
    label: "Retry exhausted",
    color: 0xfb8500,
  },
};

const SAFE_DISCORD_WEBHOOK_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "canary.discord.com",
  "ptb.discord.com",
]);

const SENSITIVE_LINE_PATTERNS = [
  /metagraphed-submission-gate/i,
  /discord(?:app)?\.com\/api\/webhooks/i,
  /(?:github_pat|gh[pousr]_|pat[_-]?|api[_-]?key|secret|token)/i,
  /\b(?:wallet|hotkey|coldkey|seed phrase|mnemonic|private key)\b/i,
  /\b(?:private prompt|private rubric|private score|private threshold|corpus weight|provider model|model detail)\b/i,
];

const SECTION_HEADING_PATTERN =
  /^(summary|recommended action|required shape|source review|security review|validation review|duplicate \/ history review|ai rationale):?$/i;

export function shouldNotifySubmissionDecision(decision = {}) {
  if (!("status" in decision) && !("public_state" in decision)) {
    return false;
  }
  if (NON_TERMINAL_NOTIFICATION_STATES.has(String(decision.public_state))) {
    return false;
  }
  return TERMINAL_NOTIFICATION_VERDICTS.has(String(decision.verdict));
}

export function buildNotificationKey({ target = {}, decision = {} }) {
  const kind = target.kind || target.target_kind || "submission";
  const repo = target.repo || target.repo_full_name || "unknown-repo";
  const number =
    target.number || target.pr_number || target.issue_number || "0";
  const revision =
    target.head_sha ||
    target.headSha ||
    target.head_ref ||
    target.headRef ||
    target.issue_revision ||
    target.issueRevision ||
    "unknown-revision";
  const status =
    decision.status || decision.public_state || decision.state || "terminal";
  const verdict = decision.verdict || "unknown-verdict";
  return [kind, repo, number, revision, status, verdict].join(":");
}

export function buildSubmissionDiscordPayload(decision = {}) {
  if (!shouldNotifySubmissionDecision(decision)) {
    return null;
  }

  const meta = VERDICT_META[decision.verdict];
  const number = decision.pr_number || decision.issue_number || "submission";
  const targetUrl = decision.pr_url || decision.issue_url || undefined;
  const candidate = decision.candidate || {};
  const sourceUrl =
    candidate.source_url ||
    candidate.source_urls?.[0] ||
    decision.source_url ||
    candidate.url ||
    null;
  const subjectSource = {
    ...candidate,
    netuid: candidate.netuid ?? decision.netuid,
    kind: candidate.kind || decision.kind,
  };
  const fields = [
    field("Result", meta.label),
    field("Netuid", candidate.netuid ?? decision.netuid ?? "n/a"),
    field("Kind", candidate.kind || decision.kind || "n/a"),
    field("Submitter", decision.submitter || "n/a"),
  ];

  if (sourceUrl) {
    fields.push(field("Source", sourceUrl, false));
  }
  if (targetUrl) {
    fields.push(field("GitHub", targetUrl, false));
  }

  return {
    username: "Metagraphed Maintainer Agent",
    embeds: [
      {
        title: truncate(
          `#${number} ${meta.action} · ${compactSubject(decision.title, subjectSource)}`,
          DISCORD_MAX_TITLE_LENGTH,
        ),
        url: targetUrl,
        color: meta.color,
        description:
          sanitizeNotificationSummary(decision.summary) ||
          fallbackNotificationSummary(meta, subjectSource),
        fields,
        footer: {
          text: "JSONbored/metagraphed · Metagraphed submission gate",
        },
        timestamp: normalizeTimestamp(decision.now),
      },
    ],
  };
}

export function sanitizeNotificationSummary(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) =>
      stripHtmlComments(line)
        .replace(/^#{1,6}\s*/, "")
        .replace(/^[-*]\s*/, "")
        .replace(/\*\*/g, "")
        .replace(/`/g, "")
        .trim(),
    )
    .filter(Boolean)
    .filter((line) => !SECTION_HEADING_PATTERN.test(line))
    .filter(
      (line) => !SENSITIVE_LINE_PATTERNS.some((pattern) => pattern.test(line)),
    );

  return truncate(lines.slice(0, 2).join(" "), DISCORD_MAX_DESCRIPTION_LENGTH);
}

export function truncate(value, limit) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  const codePoints = Array.from(text);
  if (codePoints.length <= limit) {
    return text;
  }
  return `${codePoints
    .slice(0, Math.max(0, limit - 3))
    .join("")
    .trimEnd()}...`;
}

export function validateDiscordWebhookUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:") {
    return null;
  }
  if (!SAFE_DISCORD_WEBHOOK_HOSTS.has(url.hostname)) {
    return null;
  }
  if (!/^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]{20,}$/.test(url.pathname)) {
    return null;
  }
  return url.toString();
}

function field(name, value, inline = true) {
  return {
    name,
    value: truncate(value || "n/a", DISCORD_MAX_FIELD_LENGTH),
    inline,
  };
}

function compactSubject(title, candidate = {}) {
  const fromCandidate = [
    candidate.netuid ? `SN${candidate.netuid}` : "",
    candidate.kind,
  ]
    .filter(Boolean)
    .join(" ");
  const text = String(title || fromCandidate || "submission")
    .replace(/^[a-z]+(?:\([^)]+\))?:\s*/i, "")
    .replace(/^(add|create|submit|update)\s+/i, "")
    .trim();
  return truncate(text || fromCandidate || "submission", 120);
}

function fallbackNotificationSummary(meta, candidate = {}) {
  const kind = candidate.kind ? `${candidate.kind} ` : "";
  const netuid =
    candidate.netuid !== undefined && candidate.netuid !== null
      ? `for SN${candidate.netuid}`
      : "for the registry";
  return truncate(
    `Metagraphed ${meta.action} this ${kind}submission ${netuid}.`,
    DISCORD_MAX_DESCRIPTION_LENGTH,
  );
}

function normalizeTimestamp(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return new Date().toISOString();
}

function stripHtmlComments(value) {
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("<!--", cursor);
    if (start === -1) {
      output += value.slice(cursor);
      break;
    }
    output += value.slice(cursor, start);
    const end = value.indexOf("-->", start + 4);
    if (end === -1) {
      break;
    }
    cursor = end + 3;
  }
  return output;
}
