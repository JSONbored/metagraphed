// Worker-safe on-chain identity field sanitization shared by the live identity
// history API (#1647) and the build-time profile projection. Mirrors the guards
// in scripts/lib.mjs (normalizePublicUrl, nativeContactHandle,
// isPlaceholderIdentityUrl) so operator-controlled chain strings cannot violate
// the published URI / maxLength contract.

import { sanitizeChainText } from "../scripts/lib/formatting.mjs";
import { isUnsafePublicUrl } from "./health-probe-core.mjs";

const CREDENTIALED_URL_PARAMS = new Set([
  "access_key",
  "access-token",
  "access_token",
  "api-key",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "client_id",
  "jwt",
  "key",
  "password",
  "refresh-token",
  "refresh_token",
  "secret",
  "session",
  "token",
]);

const PLACEHOLDER_IDENTITY_URL = /deprecated|username\/repo|example\.com/i;
const CONTACT_HANDLE_PATTERN = /^@?[a-z0-9][a-z0-9._-]{1,63}(?:#\d{1,6})?$/i;
const CONTACT_HANDLE_JUNK = /^(?:deprecated|none|null|n\/a|tbd|todo)$/i;

export function isCredentialedUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      return true;
    }
    for (const key of url.searchParams.keys()) {
      if (CREDENTIALED_URL_PARAMS.has(key.toLowerCase())) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function isPlaceholderIdentityUrl(value) {
  return typeof value === "string" && PLACEHOLDER_IDENTITY_URL.test(value);
}

export function normalizePublicUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  let candidate = value
    .trim()
    .replace(/^<|>$/g, "")
    .split("](")[0]
    .replace(/\]+$/g, "");
  if (!candidate) {
    return null;
  }

  if (
    !/^(https?|wss?):\/\//i.test(candidate) &&
    /^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(candidate)
  ) {
    candidate = `https://${candidate}`;
  }

  try {
    const url = new URL(candidate);
    if (
      !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
      isCredentialedUrl(url.toString()) ||
      isUnsafePublicUrl(url.toString())
    ) {
      return null;
    }
    url.hash = "";
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function nativeContactHandle(value) {
  if (typeof value !== "string") return null;
  const cleaned = sanitizeChainText(value).text.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 200) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) {
    const normalized = normalizePublicUrl(cleaned);
    return normalized && !isPlaceholderIdentityUrl(normalized)
      ? normalized
      : null;
  }
  if (
    !CONTACT_HANDLE_PATTERN.test(cleaned) ||
    CONTACT_HANDLE_JUNK.test(cleaned)
  ) {
    return null;
  }
  return cleaned;
}

export function sanitizeIdentityHistoryLink(value) {
  const normalized = normalizePublicUrl(value);
  return normalized && !isPlaceholderIdentityUrl(normalized)
    ? normalized
    : null;
}

export function sanitizeIdentityHistoryFields(fields) {
  if (!fields || typeof fields !== "object") return fields;
  return {
    ...fields,
    github_repo: sanitizeIdentityHistoryLink(fields.github_repo),
    subnet_url: sanitizeIdentityHistoryLink(fields.subnet_url),
    logo_url: sanitizeIdentityHistoryLink(fields.logo_url),
    discord: nativeContactHandle(fields.discord),
  };
}
