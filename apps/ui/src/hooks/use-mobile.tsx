import * as React from "react";

const MOBILE_BREAKPOINT = 768;

/** Pure breakpoint comparison for useIsMobile; exported for unit tests. */
export function isMobileWidth(width: number, breakpoint: number = MOBILE_BREAKPOINT): boolean {
  return width < breakpoint;
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(isMobileWidth(window.innerWidth));
    };
    mql.addEventListener("change", onChange);
    setIsMobile(isMobileWidth(window.innerWidth));
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}
