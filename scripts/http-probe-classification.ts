import { isJsonContentType } from "./lib.mjs";

type Row = Record<string, unknown>;

export type HttpProbeClassification =
  | "unsafe"
  | "unsupported"
  | "timeout"
  | "content-mismatch"
  | "redirected"
  | "live"
  | "rate-limited"
  | "auth-required"
  | "dead"
  | "transient";

interface Probe {
  unsafe_url?: boolean;
  private_redirect_blocked?: boolean;
  error?: string;
  error_class?: string;
  redirect_target?: string;
  status_code: number;
  ok?: boolean;
  content_type?: string | null;
}

export function classifyHttpProbe(
  probe: Probe,
  candidate: Row | null = null,
): HttpProbeClassification {
  if (probe.unsafe_url || probe.private_redirect_blocked) {
    return "unsafe";
  }
  if (probe.error === "redirect limit exceeded") {
    return "unsupported";
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

export function isContentMismatch(
  probe: Probe,
  candidate: Row | null,
): boolean {
  if (!candidate || !probe.ok) {
    return false;
  }
  if (candidate.kind === "openapi") {
    return !isJsonContentType(probe.content_type);
  }
  if (candidate.kind === "subnet-api") {
    return !isMachineReadableApiContentType(probe.content_type);
  }
  if (candidate.kind === "sse") {
    return !String(probe.content_type || "")
      .toLowerCase()
      .includes("text/event-stream");
  }
  return false;
}

function isMachineReadableApiContentType(contentType: unknown): boolean {
  const normalized = String(contentType || "").toLowerCase();
  return (
    normalized.includes("json") ||
    normalized.includes("text/plain") ||
    normalized.includes("text/event-stream") ||
    normalized.includes("application/octet-stream")
  );
}
