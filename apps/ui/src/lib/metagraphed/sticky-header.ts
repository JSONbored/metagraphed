/** Publish header geometry outside ResizeObserver delivery. Coalesce resize
 * bursts and avoid invalidating layout when the rounded height is unchanged. */
export function observeStickyHeader(header: HTMLElement): () => void {
  let frame: number | null = null;
  const publish = () => {
    frame = null;
    const height = `${Math.round(header.getBoundingClientRect().height)}px`;
    const style = document.documentElement.style;
    if (style.getPropertyValue("--mg-sticky-offset") !== height) {
      style.setProperty("--mg-sticky-offset", height);
    }
  };
  const schedule = () => {
    if (frame === null) frame = window.requestAnimationFrame(publish);
  };
  publish();
  const observer = new ResizeObserver(schedule);
  observer.observe(header);
  window.addEventListener("resize", schedule);
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", schedule);
    if (frame !== null) window.cancelAnimationFrame(frame);
  };
}
