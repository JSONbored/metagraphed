// Read-only native-runner journal receipt, collected outside the measured scope.
import { readFile, stat } from "node:fs/promises";

const [scope, input, readStatus] = process.argv.slice(2);
if (!/^metagraphed-resource-\d+-[a-z0-9-]+\.scope$/.test(scope ?? ""))
  throw new Error("one explicit resource scope required");
const receipt = {
  scope,
  status: "unavailable",
  reason: "",
  journal_window_max_records: 500,
  victim_membership:
    "task_memcg exact path component; descendants of measured scope count",
  victim_evidence: [] as Array<{
    pid: number;
    task: string | null;
    timestamp_us: number;
    kernel_message: string;
    correlated_killed_messages: string[];
  }>,
  limitations: [
    "a missing kernel record does not identify an OOM victim",
    "runner journal availability and a bounded window limit coverage",
    "process RSS, scope membership and scope OOM alone are not victim evidence",
  ],
};
try {
  if (readStatus !== "0") throw new Error(`journal_read_exit_${readStatus}`);
  if ((await stat(input)).size > 4 * 1024 * 1024)
    throw new Error("journal_input_exceeds_4MiB");
  const lines = (await readFile(input, "utf8")).split("\n").filter(Boolean);
  if (lines.length > 500) throw new Error("journal_input_exceeds_500_records");
  const rows = lines.map((line) => {
    const value = JSON.parse(line);
    if (typeof value.MESSAGE !== "string" || value.MESSAGE.length > 8192)
      throw new Error("unsupported_kernel_record");
    const timestamp = Number(value.__REALTIME_TIMESTAMP);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
      throw new Error("unsupported_kernel_timestamp");
    return { message: value.MESSAGE as string, timestamp };
  });
  for (const row of rows) {
    const message = /\boom-kill:([^\n]*)/.exec(row.message);
    if (!message) continue;
    const fields = Object.fromEntries(
      message[1].split(",").flatMap((part) => {
        const equal = part.indexOf("=");
        return equal < 0
          ? []
          : [[part.slice(0, equal).trim(), part.slice(equal + 1).trim()]];
      }),
    );
    // A containing OOM constraint/context does not identify the victim's
    // membership. Only task_memcg from this kernel victim record does.
    const membership = fields.task_memcg;
    if (!membership?.startsWith("/") || !membership.split("/").includes(scope))
      continue;
    if (!/^[1-9][0-9]*$/.test(fields.pid ?? "")) continue;
    const number = Number(fields.pid);
    if (!Number.isSafeInteger(number)) continue;
    receipt.victim_evidence.push({
      pid: number,
      task: fields.task || null,
      timestamp_us: row.timestamp,
      kernel_message: row.message,
      correlated_killed_messages: rows
        .filter(
          (other) =>
            Math.abs(other.timestamp - row.timestamp) <= 3_000_000 &&
            new RegExp(`\\bKilled process ${number}\\s+\\(`).test(
              other.message,
            ),
        )
        .map((other) => other.message),
    });
  }
  receipt.status = receipt.victim_evidence.length
    ? "kernel_victim_recorded"
    : "no_matching_victim_record";
  receipt.reason = "";
} catch (error) {
  receipt.reason =
    error instanceof Error ? error.message : "journal_read_failed";
}
process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
