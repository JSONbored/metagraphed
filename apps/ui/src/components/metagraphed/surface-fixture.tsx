import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { fixtureDetailQuery } from "@/lib/metagraphed/queries";
import type { FixtureIndexEntry } from "@/lib/metagraphed/types";
import { classNames } from "@/lib/metagraphed/format";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { CopyButton } from "@/components/metagraphed/copy-button";
import { TimeAgo } from "@/components/metagraphed/time-ago";

// #748: a collapsible "sample request/response" block on a surface card. A real
// captured sample is the fastest path to a first successful call — the call
// snippet shows how to call it, this shows what actually comes back. The
// (potentially large) sanitized body is fetched lazily only when expanded; the
// index entry supplies the status + capture time shown while collapsed.
export function SurfaceFixture({
  surfaceId,
  entry,
}: {
  surfaceId: string;
  entry: FixtureIndexEntry;
}) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useQuery({
    ...fixtureDetailQuery(surfaceId),
    enabled: open,
  });
  const fixture = data?.data;
  const body = fixture?.response?.body;
  const bodyText =
    body === undefined || body === null
      ? ""
      : typeof body === "string"
        ? body
        : JSON.stringify(body, null, 2);

  return (
    <div className="mt-2 rounded border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-card"
      >
        <ChevronRight
          className={classNames(
            "size-3 shrink-0 text-ink-muted transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="mg-label">sample response</span>
        {entry.response_status != null ? (
          <span className="font-mono text-[10px] text-health-ok">{entry.response_status}</span>
        ) : null}
        <span className="ml-auto font-mono text-[10px] text-ink-muted">
          <TimeAgo at={entry.captured_at ?? undefined} />
        </span>
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border px-2 py-2">
          {isLoading ? <span className="text-[11px] text-ink-muted">Loading sample…</span> : null}
          {isError ? (
            <span className="text-[11px] text-ink-muted">Sample unavailable right now.</span>
          ) : null}
          {fixture ? (
            <>
              {fixture.request?.url ? (
                <CopyableCode
                  label={fixture.request.method ?? "GET"}
                  value={fixture.request.url}
                  truncate={false}
                />
              ) : null}
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <span className="mg-label">response</span>
                  {fixture.response?.status != null ? (
                    <span className="font-mono text-[10px] text-health-ok">
                      {fixture.response.status}
                    </span>
                  ) : null}
                  {fixture.response?.content_type ? (
                    <span className="font-mono text-[10px] text-ink-muted">
                      {fixture.response.content_type}
                    </span>
                  ) : null}
                  {bodyText ? (
                    <CopyButton value={bodyText} label="response body" className="ml-auto" />
                  ) : null}
                </div>
                {bodyText ? (
                  <pre className="max-h-64 overflow-auto rounded bg-card p-2 font-mono text-[11px] leading-relaxed text-ink-strong">
                    {bodyText}
                  </pre>
                ) : (
                  <span className="text-[11px] text-ink-muted">Empty response body.</span>
                )}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
