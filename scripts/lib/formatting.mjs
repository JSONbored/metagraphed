// Chain-text formatting and sanitization helpers, extracted verbatim from
// scripts/lib.ts (#510 maintainability decomposition). All functions are pure
// with no I/O and no dependency on any other lib.ts symbol — so the output is
// byte-identical to the in-lib.ts originals. Re-exported from scripts/lib.ts
// so existing importers keep their import paths unchanged.

export function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function formatLlmMarkdownText(value, { maxLength = 160 } = {}) {
  const markdownCharacters = new Set("\\&<>{}[]()#*_`|!");
  const chars = Array.from(String(value ?? "")).slice(0, maxLength);
  let safeValue = "";

  for (const char of chars) {
    const codePoint = char.codePointAt(0);
    if (char === "\r") {
      safeValue += "\\r";
    } else if (char === "\n") {
      safeValue += "\\n";
    } else if (char === "\t") {
      safeValue += " ";
    } else if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      safeValue += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else if (markdownCharacters.has(char)) {
      safeValue += `\\${char}`;
    } else {
      safeValue += char;
    }
  }

  return safeValue;
}

export function classifyNativeName(value, netuid) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return { raw_name: null, quality: "empty" };
  }

  const normalized = raw.toLowerCase();
  const genericName =
    Number.isInteger(netuid) && normalized === `subnet ${netuid}`.toLowerCase();
  // Placeholder on-chain identities an owner may set before naming a subnet —
  // e.g. "Team TBC", "TBD", "Coming Soon". Treated as not-a-real-name so the
  // build falls back to "Subnet N" and the registry never adopts them as a
  // display name (subnet:new + validate:surface enforce this on creation/CI).
  const placeholderName =
    [
      "unknown",
      "none",
      "null",
      "n/a",
      "na",
      "unnamed",
      "untitled",
      "tbc",
      "tbd",
      "tba",
      "wip",
      "placeholder",
      "coming soon",
      "to be confirmed",
      "to be determined",
      "to be announced",
    ].includes(normalized) || /\b(?:tbc|tbd|tba)\b/.test(normalized);
  if (genericName || placeholderName || !/[\p{L}\p{N}]/u.test(raw)) {
    return { raw_name: raw, quality: "placeholder" };
  }

  return { raw_name: raw, quality: "chain" };
}

export function nativeNameQuality(subnet) {
  const rawName =
    typeof subnet?.raw_name === "string" ? subnet.raw_name : subnet?.name;
  return classifyNativeName(rawName, subnet?.netuid).quality;
}

// On-chain identity text (SubnetIdentitiesV3 description/name/additional, and any
// candidate-overlay text seeded from it) is attacker-controllable and is piped
// verbatim to LLMs via /ask, the MCP tools, search, and llms.txt. These rules
// DEFUSE prompt-injection: they neutralize the markers an attacker uses to make
// a reading model treat the data as instructions — chat-template/role tokens,
// turn/role boundaries, fence break-outs, and "ignore previous"/"act as" takeover
// phrasing — while leaving ordinary prose readable. We defang, not delete, so a
// benign description that merely mentions these words stays legible. All patterns
// use bounded quantifiers (no nested unbounded repetition) so they are
// ReDoS-safe. Order: specific tokens first, then phrasing.
const CHAIN_TEXT_INJECTION_RULES = [
  // Chat-template / model special tokens: ChatML <|...|>, Llama [INST], BOS/EOS.
  { re: /<\|[^|>\n]{0,40}\|>/g, to: " " },
  { re: /\[\/?INST\]/gi, to: " " },
  { re: /<\/?(?:s|system|user|assistant)>/gi, to: " " },
  // Fenced code/quote delimiters used to "break out" of a quoted data span.
  { re: /```+|~~~+/g, to: " " },
  // Line-start role / section markers: "System:", "### Instruction:", "Assistant：".
  {
    re: /(^|\n)[ \t]{0,8}#{0,4}[ \t]*(system|assistant|user|developer|human|instruction|prompt)[ \t]*[:：]/gi,
    to: "$1$2 ",
  },
  // Classic instruction-override phrasing ("ignore the previous instructions").
  {
    re: /\b(?:ignore|disregard|forget|override|bypass)\b(?:[ \t,]+\w+){0,4}[ \t]+(?:previous|prior|above|earlier|preceding|system|initial|all)\b[^.!?\n]{0,40}/gi,
    to: " [scrubbed] ",
  },
  // Role-takeover phrasing ("you are now ...", "act as a developer", "new instructions:").
  {
    re: /\b(?:you are now|from now on|act as(?: an?)?|pretend(?: to be| you are)?|new instructions?)\b[^.!?\n]{0,40}/gi,
    to: " [scrubbed] ",
  },
];

// Neutralize prompt-injection markers in attacker-controllable on-chain text.
// Returns the defanged text plus `scrubbed` (whether any marker was neutralized)
// so artifacts can tag `injection_scrubbed` and downstream agents know the text
// was modified and must be treated as untrusted data, never instructions.
// Deterministic + idempotent, so the build and the reproducibility validator
// derive identical output. Does NOT strip URLs — that is cleanDescription's job.
export function sanitizeChainText(value) {
  if (typeof value !== "string") return { text: null, scrubbed: false };
  let text = value;
  let scrubbed = false;
  for (const { re, to } of CHAIN_TEXT_INJECTION_RULES) {
    const next = text.replace(re, to);
    if (next !== text) scrubbed = true;
    text = next;
  }
  return { text, scrubbed };
}

export function nativeDisplayName(subnet, fallbackName = null) {
  const quality = nativeNameQuality(subnet);
  const candidate =
    quality === "chain"
      ? typeof subnet?.raw_name === "string"
        ? subnet.raw_name
        : subnet?.name
      : fallbackName;
  // Defang prompt-injection in the chain/overlay display name before it becomes
  // subnet.name. That value flows verbatim into the search index title/tokens,
  // the embeddings, the /ask RAG context, and llms.txt — the same sinks the
  // description/additional fields are scrubbed for (lib.ts threat model). The
  // injection rules are no-ops for legitimate names, so a real name is unchanged.
  const cleaned =
    typeof candidate === "string"
      ? sanitizeChainText(candidate).text
      : candidate;
  return cleaned || `Subnet ${subnet?.netuid ?? "unknown"}`;
}

// Strip embedded URLs/emails/bare-domains from free text — they shred into junk
// search tokens ("https"/"com"/"gg") and read poorly.
export function stripUrls(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b[\w.-]+@[\w.-]+\.[a-z]{2,}\b/gi, " ")
    .replace(
      /\b[\w-]+\.(?:com|io|org|net|gg|ai|xyz|dev|app|finance|sh|co)\b\S*/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

// Normalize a free-text description (chain SubnetIdentitiesV3 / overlay):
// neutralize prompt-injection, strip URLs, collapse whitespace, drop empties.
// Shared by the build + the reproducibility validator so the two never drift.
// Bare placeholder words some subnets set as their ENTIRE on-chain description
// ("deprecated", "none", "tbd", …) — treated as no description, mirroring
// CONTACT_HANDLE_JUNK. Several deprecated subnets (sn3/39/81) carry a literal
// "deprecated" description on-chain that should not leak into the served data.
const JUNK_DESCRIPTION = /^(?:deprecated|none|null|n\/a|tbd|todo|test)$/i;

export function cleanDescription(value) {
  if (typeof value !== "string") return null;
  const cleaned = stripUrls(sanitizeChainText(value).text);
  if (cleaned.length < 2) return null;
  if (JUNK_DESCRIPTION.test(cleaned.trim())) return null;
  return cleaned;
}

// Build a fallback "what does it do" blurb from curated provider notes when a
// subnet has no chain/overlay description (issue #346). Sanitized + truncated to
// a word boundary. This populates a SEPARATE derived_description field — it never
// backfills the curated description, so the gap stays visible to the SN74
// flywheel. Returns null when there is nothing usable.
export function deriveDescriptionFromNotes(notes, { maxLength = 280 } = {}) {
  if (typeof notes !== "string") return null;
  const cleaned = cleanDescription(notes);
  if (!cleaned) return null;
  // Slice by code points, not UTF-16 units (mirrors formatLlmMarkdownText): a raw
  // .slice can cut an astral character in half and emit a lone surrogate when the
  // truncation boundary or trailing-word cleanup falls between a surrogate pair.
  const chars = Array.from(cleaned);
  if (chars.length <= maxLength) return cleaned;
  return `${chars
    .slice(0, maxLength)
    .join("")
    .replace(/\s+\S*$/, "")
    .trimEnd()}…`;
}
