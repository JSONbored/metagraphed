import assert from "node:assert/strict";
import { test } from "node:test";
import { validateOwnerNativeEvents } from "./owner-native-evidence.ts";
const identity = {
  hostPid: 101,
  runtimePid: 202,
  runtimeStartTicks: "12345",
  runtimeExecutablePath: "/synthetic/workerd",
  runtimeSha256: "a".repeat(64),
  runtimeVersion: "1.20260730.1",
};
const pin = {
  path: "/synthetic/workerd",
  sha256: "a".repeat(64),
  version: "1.20260730.1",
  packagePath:
    "node_modules/miniflare/node_modules/@cloudflare/workerd-linux-64",
};
function fixture() {
  const launch = {
    kind: "native-child",
    pid: 101,
    threadId: 0,
    role: "workerd",
    childPid: 202,
    synchronous: false,
    launchId: "101:1",
  };
  return [
    {
      kind: "guard-start",
      pid: 101,
      threadId: 0,
      entry: "/synthetic/node_modules/vitest/dist/workers/forks.js",
    },
    launch,
    {
      ...launch,
      kind: "native-child-exit",
      observation: "exit-event",
      code: null,
      signal: "SIGKILL",
    },
  ] as any[];
}
test("correlates actual exact owner launch and observed pinned disposal exit", () =>
  assert.equal(
    validateOwnerNativeEvents(fixture(), identity, pin).observedNativeExits,
    1,
  ));
for (const [name, edit] of Object.entries({
  "exit before launch": (v: any[]) => ([v[1], v[2]] = [v[2], v[1]]),
  "ambiguous reused runtime PID": (v: any[]) =>
    v.push({ ...v[1], launchId: "101:2" }),
  "missing host guard": (v: any[]) => v.shift(),
  "missing launch": (v: any[]) => v.splice(1, 1),
  "missing actual exit": (v: any[]) => v.pop(),
  "duplicate launch": (v: any[]) => v.push({ ...v[1] }),
  "duplicate exit": (v: any[]) => v.push({ ...v[2] }),
  "wrong host": (v: any[]) => (v[1].pid = 303),
  "wrong runtime": (v: any[]) => (v[1].childPid = 303),
  "thread spoof launch": (v: any[]) => (v[1].threadId = 1),
  "thread spoof exit": (v: any[]) => (v[2].threadId = 1),
  "wrong native role": (v: any[]) => (v[1].role = "esbuild"),
  "synchronous substitute": (v: any[]) => (v[1].synchronous = true),
  "wrong exit owner": (v: any[]) => (v[2].pid = 303),
  "wrong exit child": (v: any[]) => (v[2].childPid = 303),
  "promise instead of exit": (v: any[]) =>
    (v[2].observation = "resolved-promise"),
  "different signal": (v: any[]) => (v[2].signal = "SIGTERM"),
  "numeric exit instead of signal": (v: any[]) => {
    v[2].code = 0;
    v[2].signal = null;
  },
  "wrong launch identity": (v: any[]) => (v[1].launchId = "303:1"),
}))
  test(`rejects owner lifecycle ${name}`, () => {
    const rows = fixture();
    edit(rows);
    assert.throws(() => validateOwnerNativeEvents(rows, identity, pin));
  });
for (const [key, value] of Object.entries({
  hostPid: 0,
  runtimePid: 101,
  runtimeStartTicks: "unknown",
}))
  test(`rejects invalid private process ${key}`, () =>
    assert.throws(() =>
      validateOwnerNativeEvents(fixture(), { ...identity, [key]: value }, pin),
    ));

for (const [key, value] of Object.entries({
  runtimeExecutablePath: "/other/workerd",
  runtimeSha256: "b".repeat(64),
  runtimeVersion: "1.20260907.1",
}))
  test(`refuses wrong actual runtime ${key}`, () =>
    assert.throws(() =>
      validateOwnerNativeEvents(fixture(), { ...identity, [key]: value }, pin),
    ));
for (const [key, value] of Object.entries({
  path: "/other/workerd",
  sha256: "b".repeat(64),
  version: "1.20260907.1",
  packagePath: "node_modules/@cloudflare/workerd-linux-64",
}))
  test(`refuses wrong pinned runtime ${key}`, () =>
    assert.throws(() =>
      validateOwnerNativeEvents(fixture(), identity, { ...pin, [key]: value }),
    ));
