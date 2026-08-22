import { useEffect } from "react";
import { classNames } from "@/lib/format";
import { TimeAgo } from "../time-ago";

/**
 * The page's one liveness line (#11607): `Updated 9s ago · refresh`, with an
 * optional source word. Exactly one per page -- a second mount throws in
 * development so a route cannot grow a second clock.
 */
export interface LiveMetaProps {
  /** ISO timestamp of the data behind the page. */
  updatedAt?: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** e.g. "chain", "registry". */
  source?: string;
  className?: string;
}

let mounted = 0;

export function LiveMeta({
  updatedAt,
  onRefresh,
  refreshing,
  source,
  className,
}: LiveMetaProps) {
  useEffect(() => {
    mounted += 1;
    if (mounted > 1 && process.env.NODE_ENV !== "production") {
      throw new Error("LiveMeta: only one liveness line per page (#11607)");
    }
    return () => {
      mounted -= 1;
    };
  }, []);
  return (
    <p className={classNames("mg-live-meta", className)} data-mg-live-meta="">
      {updatedAt ? (
        <>
          Updated <TimeAgo at={updatedAt} />
        </>
      ) : (
        "Updated —"
      )}
      {source ? <> · {source}</> : null}
      {onRefresh ? (
        <>
          {" · "}
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="mg-live-meta-refresh"
          >
            {refreshing ? "refreshing…" : "refresh"}
          </button>
        </>
      ) : null}
    </p>
  );
}
