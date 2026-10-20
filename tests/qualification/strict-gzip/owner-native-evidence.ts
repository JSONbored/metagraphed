// Correlates private procfs attribution with actual guarded child observations.
import assert from "node:assert/strict";
import path from "node:path";
import { boundedFile } from "./receipt-files.ts";
import { RAW_LIMITS } from "./receipt-policy.ts";
export interface OwnerProcessIdentity {
  hostPid: number;
  runtimePid: number;
  runtimeStartTicks: string;
  runtimeExecutablePath: string;
  runtimeSha256: string;
  runtimeVersion: string;
}
export interface NativePin {
  path: string;
  sha256: string;
  version: string;
  packagePath: string;
}
export function validateOwnerNativeEvents(
  events: readonly any[],
  identity: OwnerProcessIdentity,
  pin: NativePin,
) {
  assert.equal(
    pin.packagePath,
    "node_modules/miniflare/node_modules/@cloudflare/workerd-linux-64",
  );
  assert.equal(pin.version, "1.20260730.1");
  assert.ok(path.isAbsolute(pin.path));
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  assert.equal(identity.runtimeExecutablePath, pin.path);
  assert.equal(identity.runtimeSha256, pin.sha256);
  assert.equal(identity.runtimeVersion, pin.version);
  assert.ok(Array.isArray(events) && events.length <= 100000);
  for (const pid of [identity.hostPid, identity.runtimePid])
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.notEqual(identity.hostPid, identity.runtimePid);
  assert.match(identity.runtimeStartTicks, /^\d{1,30}$/);
  const starts = events.filter(
    (e) =>
      e.kind === "guard-start" &&
      e.pid === identity.hostPid &&
      e.threadId === 0 &&
      typeof e.entry === "string" &&
      e.entry.endsWith("/vitest/dist/workers/forks.js"),
  );
  assert.equal(starts.length, 1);
  const launches = events.filter(
    (e) => e.kind === "native-child" && e.childPid === identity.runtimePid,
  );
  assert.equal(launches.length, 1);
  const launch = launches[0];
  assert.equal(launch.pid, identity.hostPid);
  assert.equal(launch.threadId, 0);
  assert.equal(launch.role, "workerd");
  assert.equal(launch.synchronous, false);
  assert.match(launch.launchId, new RegExp(`^${identity.hostPid}:\\d+$`));
  const exits = events.filter(
    (e) => e.kind === "native-child-exit" && e.childPid === identity.runtimePid,
  );
  assert.equal(exits.length, 1);
  const exit = exits[0];
  assert.equal(exit.launchId, launch.launchId);
  assert.ok(
    events.indexOf(starts[0]) < events.indexOf(launch) &&
      events.indexOf(launch) < events.indexOf(exit),
  );
  for (const key of ["pid", "threadId", "role", "childPid", "synchronous"])
    assert.equal(exit[key], launch[key]);
  assert.equal(exit.observation, "exit-event");
  assert.equal(exit.code, null);
  assert.equal(exit.signal, "SIGKILL");
  return {
    guardedNativeLaunches: 1,
    observedNativeExits: 1,
    disposal: "miniflare-sigkill-exit-observed",
  };
}
export function readOwnerNativeEvidence(
  run: string,
  identity: OwnerProcessIdentity,
) {
  const rows = boundedFile(
    path.join(run, "network-events.ndjson"),
    RAW_LIMITS["network-events.ndjson"],
  )
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const config = JSON.parse(
    boundedFile(path.join(run, "guard-config.json"), 32768).toString(),
  );
  const pins = config.allowedNativeExecutables.filter(
    (pin: NativePin) =>
      pin.packagePath ===
      "node_modules/miniflare/node_modules/@cloudflare/workerd-linux-64",
  );
  assert.equal(pins.length, 1);
  return validateOwnerNativeEvents(rows, identity, pins[0]);
}
