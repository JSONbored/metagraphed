import { useEffect, useState } from "react";
import { getCoarsePointerMediaQuery, matchesCoarsePointer } from "@/lib/metagraphed/coarse-pointer";

/**
 * True when the viewport is touch-primary (`(hover: none), (pointer: coarse)`).
 *
 * Consumers that wrap links in Radix HoverCard should bail out and render
 * children as a passthrough so taps navigate on the first press (#5337).
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);

  useEffect(() => {
    const media = getCoarsePointerMediaQuery();
    if (!media) return;

    const update = () => setCoarse(matchesCoarsePointer(media));
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  return coarse;
}
