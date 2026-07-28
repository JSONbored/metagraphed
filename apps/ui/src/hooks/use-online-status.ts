import { useEffect, useState } from "react";

/**
 * #8384: `navigator.onLine` for the offline banner + states.tsx's
 * OfflineNotice. Starts `true` on both server and first client render
 * (matches every other browser-only hook's SSR-safety convention in this
 * codebase, e.g. useWatchlist's empty-until-effect pattern) -- a false
 * positive here would show a scary "you're offline" banner for a split
 * second on every single load, which is worse than a one-render lag before
 * a genuinely offline visitor sees the real banner.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return online;
}
