import { inheritOwnerProofReason } from "./owner-proof-reasons.ts";
// Failure-only public source identities. Never supplies acceptance evidence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import {
  identifyInputOnlyPublicImports,
  revalidateInputOnlyPublicDiagnostics,
  selectInputOnlyPublicSourcePaths,
  PUBLIC_INPUT_ONLY_LIMITS,
  type PublicSourcePin,
} from "./input-only-public-diagnostics.ts";
import { optionalProofDiagnosticMarkers } from "./optional-pg-import.ts";
import { boundedFile } from "./receipt-files.ts";
import {
  probeChainSummaryWorkspaceIdentity,
  chainSummaryWorkspaceMarker,
} from "./chain-summary-workspace-probe.ts";

export const OWNER_PUBLIC_SOURCE_INDEX_SHA256 =
  "925030f85772dc33c2ef3557b3b092b2801e59f9f82304a152112b01623e9b80";
const indexFile = fileURLToPath(
  new URL("./owner-public-source-index.json", import.meta.url),
);
const prefix = "[owner-public-input-identities:";
const suffix = ":end-owner-public-input-identities]";
const markerLimit = 57000;
let pins: readonly PublicSourcePin[] | undefined;
export function publicInputSourcePins(): readonly PublicSourcePin[] {
  if (pins) return pins;
  const bytes = boundedFile(indexFile, 512 * 1024);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    OWNER_PUBLIC_SOURCE_INDEX_SHA256,
  );
  const index = JSON.parse(bytes.toString());
  assert.deepEqual(Object.keys(index).sort(), [
    "baseCommit",
    "patchSha256",
    "sources",
  ]);
  assert.equal(index.baseCommit, "6b8422966b1411dff6d7c486f4e9a549acecc761");
  assert.equal(
    index.patchSha256,
    "67938c85de4f8e34b673cabfded73ad765fa183ee94fab0b325930ce5d6fcf72",
  );
  assert.ok(
    index.sources &&
      typeof index.sources === "object" &&
      !Array.isArray(index.sources),
  );
  const entries = Object.entries(index.sources);
  assert.equal(entries.length, 3231);
  pins = Object.freeze(
    entries.map(([name, gitBlob]) => {
      assert.match(name, /^[A-Za-z0-9_@.$[\]/-]+$/);
      assert.ok(
        name.length <= 512 &&
          !name
            .split("/")
            .some(
              (part) =>
                !part ||
                part === "." ||
                part === ".." ||
                part === "node_modules" ||
                part === ".git",
            ),
      );
      assert.equal(typeof gitBlob, "string");
      assert.match(gitBlob as string, /^[a-f0-9]{40}$/);
      return Object.freeze({ path: name, gitBlob: gitBlob as string });
    }),
  );
  return pins;
}

// A failed file read remains a missingSource refusal in the pure diagnostic.
// Every ancestor is checked before opening a leaf; no write or import occurs.
export function readPublicInputSources(
  root: string,
  dependencyRoot: string,
  metafile: unknown,
): Readonly<Record<string, Uint8Array>> {
  assert.equal(realpathSync(root), root);
  assert.equal(realpathSync(path.join(root, "node_modules")), dependencyRoot);
  const names = selectInputOnlyPublicSourcePaths({
    metafile,
    sourceRoot: root,
    dependencyRoot,
    publicSources: publicInputSourcePins(),
  });
  const sources: Record<string, Uint8Array> = Object.create(null);
  let total = 0;
  for (const name of names) {
    try {
      let current = root;
      const segments = name.split("/");
      for (const [index, segment] of segments.entries()) {
        current = path.join(current, segment);
        const stat = lstatSync(current);
        assert.ok(!stat.isSymbolicLink());
        assert.ok(
          index === segments.length - 1 ? stat.isFile() : stat.isDirectory(),
        );
        assert.equal(realpathSync(current), current);
        assert.ok(current.startsWith(root + path.sep));
      }
      const maximum = Math.min(
        PUBLIC_INPUT_ONLY_LIMITS.sourceBytes,
        PUBLIC_INPUT_ONLY_LIMITS.totalSourceBytes - total,
      );
      const bytes = Buffer.from(boundedFile(current, maximum));
      total += bytes.length;
      sources[name] = bytes;
    } catch {
      // Missing, unreadable, oversized and aliased sources are not identified.
    }
  }
  return sources;
}

const marked = new WeakMap<
  object,
  { message: string; originalFailure: unknown }
>();
export function publicInputDiagnosticMarkers(error: unknown): string {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  )
    return "";
  return marked.get(error as object)?.message ?? "";
}
export function withPublicInputDiagnostics(
  cause: unknown,
  root: string,
  metafile: unknown,
): unknown {
  const original = optionalProofDiagnosticMarkers(cause);
  if (!original) return cause;
  try {
    const canonicalRoot = realpathSync(root);
    assert.equal(root, canonicalRoot);
    const dependencyRoot = realpathSync(path.join(root, "node_modules"));
    const publicSources = publicInputSourcePins();
    const report = identifyInputOnlyPublicImports({
      metafile,
      sourceRoot: root,
      dependencyRoot,
      publicSources,
      sourceBytes: readPublicInputSources(root, dependencyRoot, metafile),
    });
    const validated = revalidateInputOnlyPublicDiagnostics(
      report,
      publicSources,
    );
    assert.ok(validated);
    const marker = prefix + JSON.stringify(validated) + suffix;
    assert.ok(marker.length <= markerLimit);
    let workspaceMarker = "";
    try {
      workspaceMarker = chainSummaryWorkspaceMarker(
        probeChainSummaryWorkspaceIdentity(root, dependencyRoot, metafile),
      );
    } catch {
      // Optional diagnostics never replace the original proof refusal.
    }
    const message =
      original +
      "\n" +
      marker +
      (workspaceMarker ? "\n" + workspaceMarker : "");
    // Keep the original failure privately. A rendered Error.cause chain would
    // duplicate its proof markers and correctly fail strict public parsing.
    const error = inheritOwnerProofReason(new Error(message), cause);
    marked.set(error, { message, originalFailure: cause });
    return error;
  } catch {
    // This optional diagnostic cannot replace or soften the original refusal.
    return cause;
  }
}

// Reconstruct only exact indexed public identities after Vitest serialization.
// Duplicate, malformed or oversized markers are omitted, never merged.
export function publicInputIdentityDiagnostics(messages: unknown) {
  try {
    if (
      types.isProxy(messages) ||
      !Array.isArray(messages) ||
      messages.length > 19
    )
      return null;
    let payload: string | undefined;
    for (let index = 0; index < messages.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(
        messages,
        String(index),
      );
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      const message = descriptor.value;
      if (typeof message !== "string" || message.length > 65536) return null;
      let at = message.indexOf(prefix);
      while (at >= 0) {
        if (payload !== undefined) return null;
        const end = message.indexOf(suffix, at + prefix.length);
        if (end < 0 || end + suffix.length - at > markerLimit) return null;
        payload = message.slice(at + prefix.length, end);
        if (payload.includes("\n") || payload.includes("\r")) return null;
        at = message.indexOf(prefix, end + suffix.length);
      }
    }
    if (payload === undefined) return null;
    return revalidateInputOnlyPublicDiagnostics(
      JSON.parse(payload),
      publicInputSourcePins(),
    );
  } catch {
    return null;
  }
}
