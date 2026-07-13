import { SparkLegend, Sparkline } from "metagraphed-ui";

export function Default() {
  return (
    <SparkLegend
      metric="Health trend"
      source="probe uptime, 5-min cadence"
      windowLabel="7d"
      updatedAt={new Date().toISOString()}
    >
      <Sparkline values={[92, 94, 91, 96, 98, 97, 99]} width={100} height={24} />
    </SparkLegend>
  );
}
