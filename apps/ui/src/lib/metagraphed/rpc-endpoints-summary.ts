import type { RpcEndpointsSummary } from "./types";

/** "N endpoints tracked · N archive-capable · N ok · N degraded · ..." built from the artifact's summary rollup. */
export function rpcEndpointsSummaryLine(summary: RpcEndpointsSummary | null): string | null {
  if (!summary) return null;
  const statusParts = Object.entries(summary.by_status ?? {})
    .sort(([, a], [, b]) => b - a)
    .map(([status, count]) => `${count} ${status}`);
  const count = summary.endpoint_count ?? 0;
  const parts = [`${count} endpoint${count === 1 ? "" : "s"} tracked`];
  if (summary.archive_supported_count != null) {
    parts.push(`${summary.archive_supported_count} archive-capable`);
  }
  parts.push(...statusParts);
  return parts.join(" · ");
}
