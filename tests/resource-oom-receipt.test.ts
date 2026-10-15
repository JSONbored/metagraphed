import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

const scope = "metagraphed-resource-123-http-envelope.scope";
function collect(messages: Array<[number, string]>, status = "0") {
  const directory = mkdtempSync(path.join(tmpdir(), "resource-kernel-"));
  try {
    const input = path.join(directory, "journal.jsonl");
    writeFileSync(
      input,
      messages
        .map(([timestamp, MESSAGE]) =>
          JSON.stringify({ __REALTIME_TIMESTAMP: String(timestamp), MESSAGE }),
        )
        .join("\n"),
    );
    return JSON.parse(
      execFileSync(
        process.execPath,
        ["scripts/collect-resource-oom.ts", scope, input, status],
        { encoding: "utf8", timeout: 5000 },
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("kernel victim must name this scope and PID; another Workerd PID is not evidence", () => {
  const receipt = collect([
    [100, "oom-kill:task_memcg=/other.scope,task=workerd,pid=22,uid=0"],
    [200, `oom-kill:task_memcg=/system.slice/${scope},task=node,pid=100,uid=0`],
    [
      201,
      "Memory cgroup out of memory: Killed process 100 (node) total-vm:999kB",
    ],
    [
      202,
      "Memory cgroup out of memory: Killed process 200 (workerd) total-vm:999kB",
    ],
    [4_000_201, "Killed process 100 (node) outside this event's time window"],
  ]);
  assert.equal(receipt.status, "kernel_victim_recorded");
  assert.equal(receipt.victim_evidence.length, 1);
  assert.equal(receipt.victim_evidence[0].pid, 100);
  assert.equal(receipt.victim_evidence[0].task, "node");
  assert.equal(receipt.victim_evidence[0].correlated_killed_messages.length, 1);
});

test("scope context and an unrelated killed process do not identify a victim", () => {
  const receipt = collect([
    [100, `${scope}: memory pressure`],
    [101, "Killed process 200 (workerd) total-vm:999kB"],
  ]);
  assert.equal(receipt.status, "no_matching_victim_record");
  assert.deepEqual(receipt.victim_evidence, []);
});

test("unavailable journal stays unavailable without inventing process attribution", () => {
  const receipt = collect([], "1");
  assert.equal(receipt.status, "unavailable");
  assert.equal(receipt.reason, "journal_read_exit_1");
  assert.deepEqual(receipt.victim_evidence, []);
});

test("lookalike scopes and constraint-only context cannot identify this victim", () => {
  const receipt = collect([
    [
      100,
      `oom-kill:oom_memcg=/system.slice/${scope},task_memcg=/system.slice/other.scope,task=workerd,pid=11,uid=0`,
    ],
    [
      101,
      `oom-kill:task_memcg=/system.slice/prefix-${scope},task=node,pid=12,uid=0`,
    ],
    [
      102,
      `oom-kill:task_memcg=/system.slice/${scope}-other,task=node,pid=13,uid=0`,
    ],
    [103, `oom-kill:task_memcg=/system.slice/${scope},task=node,pid=0,uid=0`],
    [
      104,
      `oom-kill:task_memcg=/system.slice/${scope},task=node,pid=9007199254740993,uid=0`,
    ],
  ]);
  assert.equal(receipt.status, "no_matching_victim_record");
  assert.deepEqual(receipt.victim_evidence, []);
});

test("a descendant task cgroup belongs to the measured ancestor scope", () => {
  const receipt = collect([
    [
      100,
      `oom-kill:task_memcg=/system.slice/${scope}/child,task=node,pid=100,uid=0`,
    ],
  ]);
  assert.equal(receipt.status, "kernel_victim_recorded");
  assert.equal(receipt.victim_evidence[0].pid, 100);
});
