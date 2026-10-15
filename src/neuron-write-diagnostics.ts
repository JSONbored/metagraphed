import {
  classifyLaneHealthWriteReason,
  type LaneHealthWriteFailure,
} from "./lane-health-write-diagnostics.ts";
import type { NeuronMirrorOutcome } from "./neurons-neon-write.ts";

const TABLES = [
  "neurons",
  "neuron_daily",
  "account_position_daily",
  "neurons_passes",
] as const;
type Table = (typeof TABLES)[number];
type InputRows = Record<Exclude<Table, "neurons_passes">, number>;
type Summary = {
  write_path: NeuronMirrorOutcome["writePath"];
  attempted: boolean;
  input_rows: InputRows;
  confirmed_rows: null;
  failures: Record<Table, LaneHealthWriteFailure | null>;
};

/** Samples one failed request per minute per isolate. Counts describe input,
 * never committed rows; a failure can follow commit. Only fixed table names,
 * driver classes and write paths reach the sink, without exception text. */
export function createNeuronWriteReporter(
  now: () => number = Date.now,
  emit: (summary: Summary) => void = (summary) =>
    console.warn("neuron_snapshot_write_failure", summary),
) {
  let nextReportAt = 0;
  return (outcome: NeuronMirrorOutcome, input: InputRows): void => {
    const failures = Object.fromEntries(
      TABLES.map((table) => {
        const result = outcome.results[table];
        const reason = result?.reason;
        return [
          table,
          result && !result.ok ? classifyLaneHealthWriteReason(reason) : null,
        ];
      }),
    ) as Summary["failures"];
    if (outcome.attempted && !Object.values(failures).some(Boolean)) return;
    const time = now();
    if (time < nextReportAt) return;
    nextReportAt = time + 60_000;
    try {
      emit({
        write_path: outcome.writePath,
        attempted: outcome.attempted,
        input_rows: {
          neurons: input.neurons,
          neuron_daily: input.neuron_daily,
          account_position_daily: input.account_position_daily,
        },
        confirmed_rows: null,
        failures,
      });
    } catch {
      // Diagnostics cannot change the persistence result or HTTP response.
    }
  };
}
