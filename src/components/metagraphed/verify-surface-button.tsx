import { useMutation } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/metagraphed/client";
import { classNames } from "@/lib/metagraphed/format";
import type { VerifyResult } from "@/lib/metagraphed/types";

// #1118: on-demand re-probe of a single operational surface. The backend caches
// the result 60s and rate-limits per client, so this is a cheap "is it up right
// now?" affordance. GET, but triggered imperatively → useMutation.
const STATUS_TONE: Record<string, string> = {
  ok: "text-health-ok",
  warn: "text-health-warn",
  degraded: "text-health-warn",
  down: "text-health-down",
  failed: "text-health-down",
};

export function VerifySurfaceButton({ surfaceId }: { surfaceId: string }) {
  const mutation = useMutation({
    mutationFn: async (): Promise<VerifyResult> => {
      const res = await apiFetch<VerifyResult>(
        `/api/v1/surfaces/${encodeURIComponent(surfaceId)}/verify`,
      );
      return res.data;
    },
  });

  const result = mutation.data;
  const rateLimited = mutation.error instanceof ApiError && mutation.error.status === 429;

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="rounded border border-border px-2 py-0.5 font-mono text-ink-muted transition-colors hover:border-ink-subtle hover:text-ink-strong disabled:opacity-50"
      >
        {mutation.isPending ? "Checking…" : "Verify now"}
      </button>
      {result ? (
        <span className="font-mono">
          <span
            className={classNames(
              "font-semibold",
              STATUS_TONE[String(result.status)] ?? "text-ink-muted",
            )}
          >
            {result.status ?? "unknown"}
          </span>
          {result.latency_ms != null ? (
            <span className="text-ink-muted"> · {Math.round(result.latency_ms)}ms</span>
          ) : null}
          {result.from_cache ? <span className="text-ink-muted"> · cached</span> : null}
        </span>
      ) : null}
      {mutation.isError ? (
        <span className="font-mono text-health-warn">
          {rateLimited ? "Rate-limited — try again shortly" : "Couldn’t verify"}
        </span>
      ) : null}
    </div>
  );
}
