import { createContext, useContext, type ReactNode } from "react";
import { useMetagraphedSnapshotStream, type SseStatus } from "./sse";

interface Ctx {
  status: SseStatus;
  lastEventAt: string | null;
}

const SseCtx = createContext<Ctx>({ status: "idle", lastEventAt: null });

export function LiveSseProvider({ children }: { children: ReactNode }) {
  const value = useMetagraphedSnapshotStream();
  return <SseCtx.Provider value={value}>{children}</SseCtx.Provider>;
}

export function useLiveSse() {
  return useContext(SseCtx);
}
