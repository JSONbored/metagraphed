import { StatWithSpark, Sparkline } from "metagraphed-ui";

export function Default() {
  return (
    <StatWithSpark
      label="Emission share"
      value="4.2"
      unit="%"
      hint="of total network emission"
      tone="ok"
      viz={<Sparkline values={[3.8, 3.9, 4.0, 4.1, 4.2]} width={100} height={18} />}
    />
  );
}

export function Warn() {
  return <StatWithSpark label="Validator count" value={42} hint="below target of 64" tone="warn" />;
}
