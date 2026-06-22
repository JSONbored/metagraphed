import { type ReactNode, useEffect, useState } from "react";
import { classNames } from "@/lib/metagraphed/format";

/**
 * Fade+rise on mount. Reuses the existing `.mg-route-enter` keyframe so we
 * don't ship a parallel animation. Disabled under prefers-reduced-motion via
 * the existing CSS rule.
 *
 * The wrapper remounts (and so re-animates) when `keyPart` changes. Use this
 * to animate sections inside a route that swap content without a full route
 * change.
 */
export function PageTransition({
  children,
  keyPart,
  className,
}: {
  children: ReactNode;
  keyPart?: string;
  className?: string;
}) {
  const [mountId, setMountId] = useState(0);
  useEffect(() => {
    setMountId((i) => i + 1);
  }, [keyPart]);
  return (
    <div key={mountId} className={classNames("mg-route-enter", className)}>
      {children}
    </div>
  );
}
