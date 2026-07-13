import { HealthDot } from "metagraphed-ui";

export function AllStates() {
  return (
    <div className="flex items-center gap-4">
      <HealthDot state="ok" variant="label" />
      <HealthDot state="warn" variant="label" />
      <HealthDot state="down" variant="label" />
      <HealthDot state="unknown" variant="label" />
    </div>
  );
}

export function DotOnly() {
  return (
    <div className="flex items-center gap-3">
      <HealthDot state="ok" />
      <HealthDot state="warn" />
      <HealthDot state="down" />
    </div>
  );
}
