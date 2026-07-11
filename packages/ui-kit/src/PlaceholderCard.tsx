/**
 * Proves the build pipeline end-to-end (JS + .d.ts + CSS extraction) before
 * any real component migrates. Delete once the first real component lands
 * (#4862) -- this only exists to validate the scaffold in #4860.
 */
export interface PlaceholderCardProps {
  label: string;
}

export function PlaceholderCard({ label }: PlaceholderCardProps) {
  return <div className="ui-kit-placeholder-card">{label}</div>;
}
