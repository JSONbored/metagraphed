// Measure every lane's expected population against CHAIN, and print it beside
// the constant we currently declare (#11206).
//
// WHY THIS EXISTS. Four coverage rules carried a hand-measured population
// constant. Three had rotted by 2026-08-14 and each failed PLAUSIBLY rather
// than loudly:
//
//   validator_nominator_counts  112,245 declared vs  21,547 on chain (#11166)
//   account_balances            306,000 declared vs ~366,700 live   (#11197)
//   nominator_positions          23,668 declared vs  21,263 on chain (#11177)
//
// Every one was correct when written. The comments now record HOW to re-measure
// each, which was the substance of #11182's S2 -- but instructions are not a
// command, and an audit nobody can run cheaply is an audit that happens once.
//
// NOT A CI GATE, deliberately. It walks chain storage over the public archive:
// minutes per lane, and it would make CI depend on a third party being up. Run
// it when a coverage alarm fires marginally, or before re-anchoring anything.
//
// USES THE REPO'S OWN twox128. src/twox-storage-key.ts already implements
// XXH64 and both prefix helpers, and its header states the convention plainly:
// "XXH64 implemented directly rather than adding a new npm dependency". The
// first cut of this script added `xxhash-wasm` and re-derived the same prefix
// arithmetic, which was a dependency and a duplicate that both already had an
// answer in the tree.
//
// ## THE SELF-CHECK IS STILL NOT OPTIONAL
//
// Substrate's twox128 wants the digest LITTLE-endian, and getting that wrong
// does not error -- it returns a prefix matching no keys, so a walk reports
// ZERO entries and reads exactly like an empty map. That happened twice while
// doing #11185: once from big-endian digests, once from passing the block hash
// into `state_getKeysPaged`'s startKey slot. Both gave confident wrong answers.
//
// The shared helper is well tested, so this check now guards the WIRING rather
// than the primitive -- that the prefix reaching the node is the one intended.
// `twox128("System") = 26aa394eea5630e07c48ae0c9558cef7` is published by
// Substrate and is not ours to get wrong.
import { fileURLToPath } from "node:url";
import { storageMapPrefix, twox128 } from "../src/twox-storage-key.ts";
import { ACCOUNT_BALANCES_EXPECTED_ACCOUNTS } from "../src/account-balances-staleness-watchdog.ts";
import { NEURONS_EXPECTED_NETUIDS } from "../src/neurons-staleness-watchdog.ts";
import { NOMINATOR_POSITIONS_EXPECTED_COLDKEYS } from "../src/nominator-positions-staleness-watchdog.ts";
import { VALIDATOR_NOMINATOR_COUNTS_EXPECTED_HOTKEYS } from "../src/validator-nominator-counts-staleness-watchdog.ts";

const NODE = process.env.CHAIN_RPC_URL ?? "https://archive.chain.opentensor.ai";
const PAGE = 1000;

/** The published value for `twox128("System")`. */
const SYSTEM_PREFIX = "26aa394eea5630e07c48ae0c9558cef7";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** The `0x`-prefixed storage prefix for one pallet item. */
function prefixOf(pallet: string, item: string): string {
  return `0x${hex(storageMapPrefix(pallet, item))}`;
}

function assertTwoxWiring(): void {
  const check = hex(twox128("System"));
  if (check !== SYSTEM_PREFIX) {
    throw new Error(
      `twox128 self-check failed: got ${check}, expected ${SYSTEM_PREFIX}. ` +
        `A prefix that is wrong matches no keys, so every walk below would ` +
        `report ZERO and read as an empty map rather than as an error.`,
    );
  }
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(NODE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  });
  const body = (await res.json()) as {
    result?: T;
    error?: { message: string };
  };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/**
 * Every key under a storage prefix.
 *
 * The SHORT FINAL PAGE is the termination proof and is reported: a walk that
 * ends on a full page may have been cut off, and "ended cleanly and short" is
 * exactly what distinguishes a complete scan from a server-side truncation.
 */
async function walkKeys(
  prefix: string,
  at: string,
  onProgress?: (seen: number) => void,
): Promise<{ keys: string[]; finalPage: number }> {
  const keys: string[] = [];
  let last: string | null = null;
  // Assigned on every iteration before it is read; the loop always runs at
  // least once, so there is no meaningful initial value to pick.
  let finalPage: number;
  for (;;) {
    // startKey occupies slot 3 even when null -- passing `at` there instead is
    // the second way this returned a confident zero.
    const page: string[] = await rpc<string[]>("state_getKeysPaged", [
      prefix,
      PAGE,
      last,
      at,
    ]);
    keys.push(...page);
    finalPage = page.length;
    if (page.length < PAGE) break;
    last = page[page.length - 1]!;
    onProgress?.(keys.length);
  }
  return { keys, finalPage };
}

/**
 * The Alpha key layout, which is 130 bytes and NOT what it looks like.
 *
 * prefix(32) + blake2_128_concat(hotkey)(16+32) + blake2_128_concat(coldkey)
 * (16+32) + netuid(2). The netuid is IDENTITY-hashed -- no hash prefix, two
 * bytes at the tail. Reading it at a hashed offset makes every entry decode as
 * netuid 0, which is how a first attempt reported the whole map as root.
 */
export function decodeAlphaKey(key: string): {
  hotkey: string;
  coldkey: string;
  netuid: number;
} {
  const b = key.slice(2);
  return {
    hotkey: b.slice(96, 160),
    coldkey: b.slice(192, 256),
    netuid: Buffer.from(b.slice(256, 260), "hex").readUInt16LE(0),
  };
}

interface Measured {
  lane: string;
  declared: number;
  measured: number;
  note: string;
}

function report(rows: Measured[]): void {
  for (const r of rows) {
    const drift = ((r.measured - r.declared) / r.declared) * 100;
    const flag = Math.abs(drift) >= 5 ? "  <-- RE-ANCHOR" : "";
    process.stdout.write(
      `${r.lane.padEnd(28)} declared ${String(r.declared).padStart(9)}  ` +
        `chain ${String(r.measured).padStart(9)}  ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}%${flag}\n` +
        `${"".padEnd(28)} ${r.note}\n`,
    );
  }
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const wants = (lane: string) => only.length === 0 || only.includes(lane);

  assertTwoxWiring();
  const at = await rpc<string>("chain_getFinalizedHead", []);
  process.stdout.write(`node ${NODE}\nat   ${at}\n\n`);

  const rows: Measured[] = [];

  if (wants("neurons")) {
    const key = prefixOf("SubtensorModule", "TotalNetworks");
    const raw = await rpc<string | null>("state_getStorage", [key, at]);
    const total = raw ? Buffer.from(raw.slice(2), "hex").readUInt16LE(0) : 0;
    rows.push({
      lane: "neurons",
      declared: NEURONS_EXPECTED_NETUIDS,
      measured: total,
      note: "SubtensorModule::TotalNetworks -- NETUIDS, so subnets + root (netuid 0)",
    });
  }

  const needsAlpha =
    wants("validator-nominator-counts") || wants("nominator-positions");
  if (needsAlpha) {
    const prefix = prefixOf("SubtensorModule", "Alpha");
    process.stdout.write("walking SubtensorModule::Alpha ...\n");
    const { keys, finalPage } = await walkKeys(prefix, at, (n) => {
      if (n % 40_000 === 0) process.stdout.write(`  ...${n}\n`);
    });
    const ended =
      finalPage < PAGE
        ? `ended on a SHORT page (${finalPage}) -- clean end of iteration`
        : `ended on a FULL page -- possibly TRUNCATED, do not anchor on this`;
    const hotkeys = new Set<string>();
    const coldkeysNonRoot = new Set<string>();
    for (const key of keys) {
      const { hotkey, coldkey, netuid } = decodeAlphaKey(key);
      hotkeys.add(hotkey);
      if (netuid !== 0) coldkeysNonRoot.add(coldkey);
    }
    if (wants("validator-nominator-counts")) {
      rows.push({
        lane: "validator-nominator-counts",
        declared: VALIDATOR_NOMINATOR_COUNTS_EXPECTED_HOTKEYS,
        measured: hotkeys.size,
        note: `distinct hotkeys over ${keys.length} Alpha entries; ${ended}`,
      });
    }
    if (wants("nominator-positions")) {
      rows.push({
        lane: "nominator-positions",
        declared: NOMINATOR_POSITIONS_EXPECTED_COLDKEYS,
        measured: coldkeysNonRoot.size,
        note:
          `distinct coldkeys with netuid != 0; the sink also filters shares > 0, ` +
          `which removed NOTHING when measured 2026-08-14 (zero such entries)`,
      });
    }
  }

  if (wants("account-balances")) {
    // Keys only. The lane's population is the NONZERO-balance subset, which
    // needs storage VALUES for every account -- ~543k reads, and the walk timed
    // out when attempted. So this reports the ceiling and says so rather than
    // printing a number that means something else.
    process.stdout.write("walking System::Account (slow) ...\n");
    const prefix = prefixOf("System", "Account");
    const { keys, finalPage } = await walkKeys(prefix, at, (n) => {
      if (n % 100_000 === 0) process.stdout.write(`  ...${n}\n`);
    });
    rows.push({
      lane: "account-balances",
      declared: ACCOUNT_BALANCES_EXPECTED_ACCOUNTS,
      measured: keys.length,
      note:
        `System::Account entries -- a CEILING, not the population: the lane skips ` +
        `accounts whose free and reserved are both zero${finalPage < PAGE ? "" : " (FULL final page -- suspect truncation)"}`,
    });
  }

  process.stdout.write("\n");
  report(rows);
  process.stdout.write(
    "\nA lane over 5% adrift wants re-anchoring. Record the METHOD in the\n" +
      "constant's comment, never just the number, and never anchor on a table's\n" +
      "own row count -- these tables accumulate, so that reproduces the stale\n" +
      "figure the drift came from.\n",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
