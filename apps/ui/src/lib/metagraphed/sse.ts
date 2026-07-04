import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getApiBase } from "./config";

export type SseStatus = "idle" | "connecting" | "open" | "error" | "closed";

/**
 * Subscribe to /api/v1/events (SSE). On each `snapshot` event invalidates
 * health/coverage/subnets/surfaces/freshness queries so they refetch.
 * Auto-reconnect handled by EventSource's built-in `retry` directive.
 * SSR-safe: no-op on server.
 */
export function useMetagraphedSnapshotStream() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<SseStatus>("idle");
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let cancelled = false;
    const url = `${getApiBase()}/api/v1/events`;
    setStatus("connecting");
    let es: EventSource;
    try {
      es = new EventSource(url);
    } catch {
      setStatus("error");
      return;
    }
    esRef.current = es;

    const onOpen = () => !cancelled && setStatus("open");
    const onError = () => !cancelled && setStatus("error");
    const onMessage = () => {
      if (cancelled) return;
      setLastEventAt(new Date().toISOString());
      // Invalidate the families that re-derive from each publish.
      qc.invalidateQueries({ queryKey: ["metagraphed", "health"] });
      qc.invalidateQueries({ queryKey: ["metagraphed", "subnet-health"] });
      qc.invalidateQueries({ queryKey: ["metagraphed", "coverage"] });
      qc.invalidateQueries({ queryKey: ["metagraphed", "freshness"] });
      qc.invalidateQueries({ queryKey: ["metagraphed", "subnets"] });
      qc.invalidateQueries({ queryKey: ["metagraphed", "surfaces"] });
    };

    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError);
    es.addEventListener("message", onMessage);
    es.addEventListener("snapshot", onMessage as EventListener);

    return () => {
      cancelled = true;
      es.removeEventListener("open", onOpen);
      es.removeEventListener("error", onError);
      es.removeEventListener("message", onMessage);
      es.removeEventListener("snapshot", onMessage as EventListener);
      es.close();
      setStatus("closed");
    };
  }, [qc]);

  return { status, lastEventAt };
}
