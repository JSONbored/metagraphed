import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

function runPython(script) {
  const result = spawnSync("python", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("fetch-events _safe_json strips actual NULs without corrupting literal escapes", () => {
  const stdout = runPython(String.raw`
import importlib.util
import json

spec = importlib.util.spec_from_file_location("fetch_events", "scripts/fetch-events.py")
fetch_events = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch_events)

actual_nul = fetch_events._safe_json({"data": "x\x00y", "\x00key": "value"})
literal_escape = fetch_events._safe_json({"data": "x\\u0000y"})
extrinsic = fetch_events._extrinsic_call({
    "call": {
        "call_module": "SubtensorModule",
        "call_function": "set_weights",
        "call_args": [{"name": "data", "value": "x\\u0000y"}],
    }
})

print(json.dumps({
    "actual_nul": json.loads(actual_nul),
    "literal_escape": json.loads(literal_escape),
    "extrinsic_args": json.loads(extrinsic[2]),
}, separators=(",", ":")))
`);
  assert.deepEqual(JSON.parse(stdout), {
    actual_nul: { data: "xy", key: "value" },
    literal_escape: { data: "x\\u0000y" },
    extrinsic_args: [{ name: "data", value: "x\\u0000y" }],
  });
});
