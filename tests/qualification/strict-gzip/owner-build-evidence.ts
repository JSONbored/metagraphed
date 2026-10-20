import {
  ownerProofFailure,
  withOwnerProofReason,
  withOwnerProofReasonAsync,
} from "./owner-proof-reasons.ts";
import { ownerBuildStageFailure } from "./owner-build-stages.ts";
import { withPublicInputDiagnostics } from "./owner-input-diagnostics.ts";
import {
  DISCARDED_INPUT_SOURCE_PINS,
  ERASURE_CONFIG_SOURCE_PINS,
  planDiscardedInputReads,
} from "./discarded-input-proof.ts";
import {
  OPTIONAL_PG_SOURCE_PINS,
  ownerSourceIdentity,
  validateOptionalPgNativeImport,
  type OptionalPgMetafile,
  type OptionalPgEvidence,
  type PreservedOptionalPgOutput,
} from "./optional-pg-import.ts";
import { assertOwnerExternalImport } from "./owner-resource-policy.ts";
import { OWNER_PG_SOURCES, assertOwnerPgSource } from "./owner-pg-identity.ts";
// Private build evidence is never uploaded. Only validated hashes/counts escape.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";

import type { Owner } from "./owner-resource-policy.ts";
function sourceFile(root: string, relative: string): string {
  relativeName(relative);
  const file = path.join(root, relative);
  regular(file);
  const canonical = withOwnerProofReason("evidence-001", () =>
    realpathSync(file),
  );
  const allowed = relative.startsWith("node_modules/")
    ? withOwnerProofReason("evidence-002", () =>
        realpathSync(path.join(root, "node_modules")),
      )
    : withOwnerProofReason("evidence-003", () => realpathSync(root));
  try {
    assert.ok(canonical.startsWith(allowed + path.sep));
  } catch (cause) {
    throw ownerProofFailure(cause, "evidence-004");
  }
  return file;
}
// Bind the lexical metadata identity to the exact canonical source file. Both
// the genuine metadata spelling and the logical custody path must name it.
export function ownerBuildInputIdentity(
  root: string,
  dependencyRoot: string,
  name: string,
): string {
  try {
    assert.equal(realpathSync(root), root);
  } catch (cause) {
    throw ownerProofFailure(cause, "evidence-005");
  }
  try {
    assert.equal(realpathSync(path.join(root, "node_modules")), dependencyRoot);
  } catch (cause) {
    throw ownerProofFailure(cause, "evidence-006");
  }
  const logical = ownerSourceIdentity(root, dependencyRoot, name);
  const expected = logical.startsWith("node_modules/")
    ? path.join(dependencyRoot, logical.slice("node_modules/".length))
    : path.join(root, logical);
  try {
    assert.equal(realpathSync(path.resolve(root, name)), expected);
  } catch (cause) {
    throw ownerProofFailure(cause, "evidence-007");
  }
  try {
    assert.equal(realpathSync(path.join(root, logical)), expected);
  } catch (cause) {
    throw ownerProofFailure(cause, "evidence-008");
  }
  return logical;
}
// Read only the fixed public source/config inventory for an exact reviewed
// batch. This read plan never grants admission; the full proof hashes it again.
export function readDiscardedInputEvidence(
  root: string,
  dependencyRoot: string,
  metafile: unknown,
): Pick<OptionalPgEvidence, "discardedInputSources" | "erasureConfigSources"> {
  let proofStage = "discarded-input-sources";
  try {
    try {
      assert.equal(realpathSync(root), root);
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-009");
    }
    try {
      assert.equal(
        realpathSync(path.join(root, "node_modules")),
        dependencyRoot,
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-010");
    }
    const plan = planDiscardedInputReads(
      metafile,
      new Map(
        Object.keys(DISCARDED_INPUT_SOURCE_PINS).map((logical) => [
          logical,
          logical,
        ]),
      ),
    );
    if (!plan) return {};
    const discardedInputSources = Object.fromEntries(
      plan.sources.map(({ logical, actual }) => {
        try {
          assert.equal(
            ownerBuildInputIdentity(root, dependencyRoot, actual),
            logical,
          );
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-011");
        }
        const pin =
          DISCARDED_INPUT_SOURCE_PINS[
            logical as keyof typeof DISCARDED_INPUT_SOURCE_PINS
          ];
        try {
          assert.ok(pin);
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-012");
        }
        return [actual, boundedBuildFile(sourceFile(root, logical), pin.bytes)];
      }),
    );
    proofStage = "erasure-config-sources";
    const erasureConfigSources = Object.fromEntries(
      plan.configs.map((relative) => {
        try {
          assert.equal(
            ownerBuildInputIdentity(root, dependencyRoot, relative),
            relative,
          );
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-013");
        }
        const pin =
          ERASURE_CONFIG_SOURCE_PINS[
            relative as keyof typeof ERASURE_CONFIG_SOURCE_PINS
          ];
        try {
          assert.ok(pin);
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-014");
        }
        return [
          relative,
          boundedBuildFile(sourceFile(root, relative), pin.bytes),
        ];
      }),
    ) as unknown as NonNullable<OptionalPgEvidence["erasureConfigSources"]>;
    return { discardedInputSources, erasureConfigSources };
  } catch (cause) {
    throw ownerBuildStageFailure("optional-adapter", proofStage, cause);
  }
}
// Read-only adapter for the single source-proven unresolved optional require.
// It never resolves/imports a package and never changes any environment value.
export function optionalPgBuildAssociation(
  root: string,
  outputRoot: string,
  metafile: OptionalPgMetafile,
  outputs: PreservedOptionalPgOutput[],
  registeredModuleNames: string[],
) {
  let proofStage = "environment";
  try {
    try {
      assert.equal(Object.hasOwn(process.env, "NODE_PG_FORCE_NATIVE"), false);
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-015");
    }
    const dependencyRoot = withOwnerProofReason("evidence-016", () =>
      realpathSync(path.join(root, "node_modules")),
    );
    proofStage = "native-absence";
    for (const relative of [
      "pg-native",
      "pg/node_modules/pg-native",
      "pg/lib/node_modules/pg-native",
      "pg/lib/native/node_modules/pg-native",
    ]) {
      let absent = false;
      try {
        withOwnerProofReason("evidence-017", () =>
          lstatSync(path.join(dependencyRoot, relative)),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        absent = true;
      }
      try {
        assert.ok(absent, "No optional native package may be supplied");
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-018");
      }
    }
    const needsProof = Object.values(metafile.outputs).some((output) =>
      output.imports.some((dependency) => dependency.path === "pg-native"),
    );
    proofStage = "source-bytes";
    const sources = needsProof
      ? Object.fromEntries(
          Object.keys(OPTIONAL_PG_SOURCE_PINS).map((relative) => [
            relative,
            boundedBuildFile(sourceFile(root, relative), 64 * 1024),
          ]),
        )
      : {};
    const discarded = readDiscardedInputEvidence(
      withOwnerProofReason("evidence-019", () => realpathSync(root)),
      dependencyRoot,
      metafile,
    );
    proofStage = "proof";
    return validateOptionalPgNativeImport({
      sourceRoot: withOwnerProofReason("evidence-020", () =>
        realpathSync(root),
      ),
      dependencyRoot,
      outputRoot,
      metafile,
      sources,
      ...discarded,
      outputs,
      registeredModuleNames,
    });
  } catch (cause) {
    throw ownerBuildStageFailure(
      "optional-adapter",
      proofStage,
      withPublicInputDiagnostics(cause, root, metafile),
    );
  }
}

export function boundedBuildFile(file: string, maximum: number): Buffer {
  try {
    assert.ok(
      Number.isSafeInteger(maximum) &&
        maximum >= 0 &&
        maximum <= 256 * 1024 * 1024,
    );
  } catch (cause) {
    throw ownerProofFailure(cause, "evidence-021");
  }
  const fd = withOwnerProofReason("evidence-022", () =>
    openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ),
  );
  try {
    const stat = withOwnerProofReason("evidence-023", () => fstatSync(fd));
    try {
      assert.ok(stat.isFile() && stat.size <= maximum);
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-024");
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = withOwnerProofReason("evidence-025", () =>
        readSync(fd, bytes, used, bytes.length - used, null),
      );
      if (!count) break;
      used += count;
    }
    try {
      assert.equal(used, stat.size);
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-026");
    }
    try {
      assert.equal(fstatSync(fd).size, stat.size);
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-027");
    }
    return bytes.subarray(0, used);
  } finally {
    withOwnerProofReason("evidence-028", () => closeSync(fd));
  }
}
const hash = (bytes: Uint8Array) =>
  withOwnerProofReason("evidence-029", () =>
    createHash("sha256").update(bytes).digest("hex"),
  );
export const OWNER_BUILD_LIMITS = {
  files: 257,
  moduleBytes: 32 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  associationBytes: 64 * 1024 * 1024,
  manifestBytes: 512 * 1024,
} as const;
export interface RegisteredOwnerModule {
  name: string;
  type: "ESModule" | "CommonJS" | "CompiledWasm" | "Data" | "Text";
  bytes: Uint8Array;
}
interface SourceIdentity {
  path: string;
  sha256: string;
}
export interface OwnerBuildManifest {
  version: 1;
  owner: Owner;
  entry: string;
  association: {
    kind: "api-builder" | "wrangler-upload";
    file: "association.bin";
    bytes: number;
    sha256: string;
  };
  modules: {
    name: string;
    type: RegisteredOwnerModule["type"];
    file: string;
    bytes: number;
    sha256: string;
  }[];
  sources: SourceIdentity[];
}
export interface ExpectedOwnerIdentity {
  runtimeSha256: string;
  modules: { sha256: string; bytes: number }[];
}
function regular(file: string) {
  const info = withOwnerProofReason("evidence-030", () => lstatSync(file));
  try {
    assert.ok(info.isFile() && !info.isSymbolicLink());
  } catch (cause) {
    throw ownerProofFailure(cause, "evidence-031");
  }
}
function relativeName(name: string) {
  try {
    assert.ok(
      name.length > 0 &&
        name.length <= 512 &&
        !path.isAbsolute(name) &&
        !name.includes("\\") &&
        !name.split("/").some((part) => part === ".." || !part || part === "."),
    );
  } catch (cause) {
    throw ownerProofFailure(cause, "evidence-032");
  }
}
const requiredSources = {
  raw: [
    "workers/api.entry.ts",
    "workers/api.ts",
    "scripts/build-api-worker.ts",
    "src/raw-chain-capture.ts",
    "src/raw-capture-d1.ts",
    "wrangler.jsonc",
  ],
  queue: [
    "workers/data-api.ts",
    "wrangler.data.jsonc",
    "src/pg-sql.ts",
    "src/sync-batch-compress.ts",
    "src/strict-gzip-reader.ts",
    ...Object.keys(OWNER_PG_SOURCES).map(
      (relative) => `node_modules/${relative}`,
    ),
  ],
} as const;
export function preserveOwnerBuild(
  owner: Owner,
  entry: string,
  modules: RegisteredOwnerModule[],
  sourcePaths: string[],
  association: { kind: "api-builder" | "wrangler-upload"; bytes: Uint8Array },
) {
  let proofStage = "directory";
  try {
    const result = process.env.DECODER_QUALIFICATION_RESULT,
      root = process.env.DECODER_QUALIFICATION_ROOT;
    try {
      assert.ok(
        result && root && path.isAbsolute(result) && path.isAbsolute(root),
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-033");
    }
    const directory = path.join(path.dirname(result), "owner-builds", owner);
    withOwnerProofReason("evidence-034", () =>
      mkdirSync(directory, { recursive: true, mode: 0o700 }),
    );
    try {
      assert.equal(readdirSync(directory).length, 0);
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-035");
    }
    proofStage = "modules";
    try {
      assert.ok(
        modules.length > 0 && modules.length <= OWNER_BUILD_LIMITS.files - 2,
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-036");
    }
    let total = 0;
    const names = new Set<string>();
    const stored = modules.map((module, index) => {
      relativeName(module.name);
      try {
        assert.ok(!names.has(module.name));
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-037");
      }
      names.add(module.name);
      try {
        assert.ok(
          ["ESModule", "CommonJS", "CompiledWasm", "Data", "Text"].includes(
            module.type,
          ),
        );
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-038");
      }
      try {
        assert.ok(
          module.bytes.byteLength > 0 &&
            module.bytes.byteLength <= OWNER_BUILD_LIMITS.moduleBytes,
        );
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-039");
      }
      total += module.bytes.byteLength;
      try {
        assert.ok(total <= OWNER_BUILD_LIMITS.totalBytes);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-040");
      }
      const file = `module-${String(index).padStart(3, "0")}.bin`;
      withOwnerProofReason("evidence-041", () =>
        writeFileSync(path.join(directory, file), module.bytes, {
          flag: "wx",
          mode: 0o600,
        }),
      );
      return {
        name: module.name,
        type: module.type,
        file,
        bytes: module.bytes.byteLength,
        sha256: hash(module.bytes),
      };
    });
    proofStage = "entry";
    try {
      assert.equal(entry, owner === "raw" ? "api.entry.js" : "data-api.js");
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-042");
    }
    try {
      assert.ok(names.has(entry));
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-043");
    }
    try {
      assert.equal(
        modules.find((module) => module.name === entry)!.type,
        "ESModule",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-044");
    }
    proofStage = "sources";
    const sources = [...new Set([...sourcePaths, ...requiredSources[owner]])]
      .sort()
      .map((relative) => {
        const file = sourceFile(root, relative);
        const bytes = boundedBuildFile(file, 32 * 1024 * 1024);
        return { path: relative, sha256: hash(bytes) };
      });
    proofStage = "association";
    try {
      assert.equal(
        association.kind,
        owner === "raw" ? "api-builder" : "wrangler-upload",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-045");
    }
    try {
      assert.ok(
        association.bytes.byteLength > 0 &&
          association.bytes.byteLength <= OWNER_BUILD_LIMITS.associationBytes,
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-046");
    }
    try {
      assert.ok(
        total + association.bytes.byteLength <= OWNER_BUILD_LIMITS.totalBytes,
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-047");
    }
    withOwnerProofReason("evidence-048", () =>
      writeFileSync(
        path.join(directory, "association.bin"),
        association.bytes,
        {
          flag: "wx",
          mode: 0o600,
        },
      ),
    );
    proofStage = "manifest";
    const manifest: OwnerBuildManifest = {
      version: 1,
      owner,
      entry,
      modules: stored,
      sources,
      association: {
        kind: association.kind,
        file: "association.bin",
        bytes: association.bytes.byteLength,
        sha256: hash(association.bytes),
      },
    };
    const serialized = JSON.stringify(manifest) + "\n";
    try {
      assert.ok(
        Buffer.byteLength(serialized) <= OWNER_BUILD_LIMITS.manifestBytes,
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-049");
    }
    withOwnerProofReason("evidence-050", () =>
      writeFileSync(path.join(directory, "manifest.json"), serialized, {
        flag: "wx",
        mode: 0o600,
      }),
    );
    return manifest.modules.map(({ sha256, bytes }) => ({ sha256, bytes }));
  } catch (cause) {
    throw ownerBuildStageFailure("preserve", proofStage, cause);
  }
}

export async function validateOwnerBuild(
  directory: string,
  owner: Owner,
  root: string,
  expectedRuntimeSha256: string,
): Promise<ExpectedOwnerIdentity> {
  let proofStage = "runtime-identity";
  try {
    try {
      assert.match(expectedRuntimeSha256, /^[a-f0-9]{64}$/);
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-051");
    }
    proofStage = "directory";
    const stat = withOwnerProofReason("evidence-052", () =>
      lstatSync(directory),
    );
    try {
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-053");
    }
    const entries = withOwnerProofReason("evidence-054", () =>
      readdirSync(directory, { withFileTypes: true }),
    );
    try {
      assert.ok(
        entries.length >= 2 && entries.length <= OWNER_BUILD_LIMITS.files,
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-055");
    }
    try {
      assert.ok(
        entries.every((entry) => entry.isFile() && !entry.isSymbolicLink()),
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-056");
    }
    proofStage = "manifest";
    const manifest = withOwnerProofReason("evidence-057", () =>
      JSON.parse(
        boundedBuildFile(
          path.join(directory, "manifest.json"),
          OWNER_BUILD_LIMITS.manifestBytes,
        ).toString(),
      ),
    ) as OwnerBuildManifest;
    try {
      assert.equal(manifest.version, 1);
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-058");
    }
    try {
      assert.equal(manifest.owner, owner);
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-059");
    }
    try {
      assert.ok(
        Array.isArray(manifest.modules) &&
          manifest.modules.length > 0 &&
          manifest.modules.length <= OWNER_BUILD_LIMITS.files - 2,
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-060");
    }
    try {
      assert.deepEqual(
        entries.map((e) => e.name).sort(),
        [
          "manifest.json",
          "association.bin",
          ...manifest.modules.map((row) => row.file),
        ].sort(),
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-061");
    }
    proofStage = "modules";
    let total = 0;
    const names = new Set<string>();
    const modules = manifest.modules.map((module, index) => {
      relativeName(module.name);
      try {
        assert.ok(!names.has(module.name));
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-062");
      }
      names.add(module.name);
      try {
        assert.ok(
          ["ESModule", "CommonJS", "CompiledWasm", "Data", "Text"].includes(
            module.type,
          ),
        );
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-063");
      }
      try {
        assert.equal(
          module.file,
          `module-${String(index).padStart(3, "0")}.bin`,
        );
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-064");
      }
      const bytes = boundedBuildFile(
        path.join(directory, module.file),
        OWNER_BUILD_LIMITS.moduleBytes,
      );
      total += bytes.byteLength;
      try {
        assert.ok(total <= OWNER_BUILD_LIMITS.totalBytes);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-065");
      }
      try {
        assert.equal(bytes.byteLength, module.bytes);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-066");
      }
      try {
        assert.ok(module.bytes > 0);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-067");
      }
      try {
        assert.equal(hash(bytes), module.sha256);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-068");
      }
      return { sha256: module.sha256, bytes: module.bytes };
    });
    proofStage = "entry";
    try {
      assert.equal(
        manifest.entry,
        owner === "raw" ? "api.entry.js" : "data-api.js",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-069");
    }
    try {
      assert.ok(names.has(manifest.entry));
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-070");
    }
    try {
      assert.equal(
        manifest.modules.find((module) => module.name === manifest.entry)!.type,
        "ESModule",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-071");
    }
    proofStage = "sources";
    try {
      assert.ok(
        Array.isArray(manifest.sources) &&
          manifest.sources.length > 0 &&
          manifest.sources.length <= 4096,
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-072");
    }
    const seen = new Set<string>();
    for (const source of manifest.sources) {
      relativeName(source.path);
      try {
        assert.ok(!seen.has(source.path));
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-073");
      }
      seen.add(source.path);
      try {
        assert.equal(
          hash(
            boundedBuildFile(sourceFile(root, source.path), 32 * 1024 * 1024),
          ),
          source.sha256,
        );
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-074");
      }
    }
    for (const required of requiredSources[owner])
      try {
        assert.ok(seen.has(required));
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-075");
      }
    if (owner === "queue")
      for (const relative of Object.keys(OWNER_PG_SOURCES))
        assertOwnerPgSource(
          relative,
          boundedBuildFile(
            sourceFile(root, `node_modules/${relative}`),
            32 * 1024 * 1024,
          ),
        );
    proofStage = "association";
    try {
      assert.equal(
        manifest.association.kind,
        owner === "raw" ? "api-builder" : "wrangler-upload",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-076");
    }
    try {
      assert.equal(manifest.association.file, "association.bin");
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-077");
    }
    const association = boundedBuildFile(
      path.join(directory, "association.bin"),
      OWNER_BUILD_LIMITS.associationBytes,
    );
    try {
      assert.equal(association.byteLength, manifest.association.bytes);
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-078");
    }
    try {
      assert.equal(hash(association), manifest.association.sha256);
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-079");
    }
    try {
      assert.ok(
        total + association.byteLength <= OWNER_BUILD_LIMITS.totalBytes,
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-080");
    }
    await validateBuildAssociation(
      owner,
      association,
      manifest,
      root,
      directory,
    );
    return { runtimeSha256: expectedRuntimeSha256, modules };
  } catch (cause) {
    throw ownerBuildStageFailure("validate", proofStage, cause);
  }
}

export function runnerRuntimeIdentity(run: string, root: string): string {
  const config = withOwnerProofReason("evidence-081", () =>
    JSON.parse(
      boundedBuildFile(
        path.join(run, "guard-config.json"),
        32 * 1024,
      ).toString(),
    ),
  );
  try {
    assert.equal(config.root, realpathSync(root));
  } catch (cause) {
    throw ownerProofFailure(cause, "evidence-082");
  }
  try {
    assert.ok(Array.isArray(config.allowedNativeExecutables));
  } catch (cause) {
    throw ownerProofFailure(cause, "evidence-083");
  }
  const expected = withOwnerProofReason("evidence-084", () =>
    realpathSync(
      path.join(
        root,
        "node_modules/miniflare/node_modules/@cloudflare/workerd-linux-64/bin/workerd",
      ),
    ),
  );
  const matches = config.allowedNativeExecutables.filter(
    (row: Record<string, unknown>) =>
      row.packagePath ===
      "node_modules/miniflare/node_modules/@cloudflare/workerd-linux-64",
  );
  try {
    assert.equal(matches.length, 1);
  } catch (cause) {
    throw ownerProofFailure(cause, "evidence-085");
  }
  try {
    assert.equal(matches[0].path, expected);
  } catch (cause) {
    throw ownerProofFailure(cause, "evidence-086");
  }
  try {
    assert.equal(matches[0].version, "1.20260730.1");
  } catch (cause) {
    throw ownerProofFailure(cause, "evidence-087");
  }
  try {
    assert.equal(
      matches[0].sha256,
      hash(boundedBuildFile(expected, 256 * 1024 * 1024)),
    );
  } catch (cause) {
    throw ownerProofFailure(cause, "evidence-088");
  }
  return matches[0].sha256;
}

async function validateBuildAssociation(
  owner: Owner,
  bytes: Buffer,
  manifest: OwnerBuildManifest,
  root: string,
  directory: string,
) {
  let proofStage = "setup";
  try {
    const moduleBytes = (name: string) => {
      const row = manifest.modules.find((module) => module.name === name);
      try {
        assert.ok(row);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-089");
      }
      return boundedBuildFile(
        path.join(directory, row.file),
        OWNER_BUILD_LIMITS.moduleBytes,
      );
    };
    const matchSources = (
      map: Record<string, unknown>,
      sourceNames: readonly string[],
    ) => {
      try {
        assert.equal(map.version, 3);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-090");
      }
      try {
        assert.ok(
          Array.isArray(map.sources) && Array.isArray(map.sourcesContent),
        );
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-091");
      }
      try {
        assert.equal(map.sources.length, map.sourcesContent.length);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-092");
      }
      try {
        assert.ok(map.sources.length <= 8192);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-093");
      }
      for (const relative of sourceNames) {
        const matches: number[] = (map.sources as unknown[]).flatMap(
          (source, index) =>
            typeof source === "string" &&
            (source === relative ||
              source.replaceAll("\\", "/").endsWith("/" + relative))
              ? [index]
              : [],
        );
        if (!matches.length) continue;
        for (const index of matches)
          try {
            assert.equal(
              (map.sourcesContent as unknown[])[index],
              boundedBuildFile(
                sourceFile(root, relative),
                32 * 1024 * 1024,
              ).toString(),
            );
          } catch (cause) {
            throw ownerProofFailure(cause, "evidence-094");
          }
      }
    };
    if (owner === "queue") {
      proofStage = "queue-envelope";
      const end = bytes.indexOf("\r\n");
      try {
        assert.ok(end > 2 && end < 200);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-095");
      }
      const line = bytes.subarray(0, end).toString();
      try {
        assert.match(line, /^--[-A-Za-z0-9]+$/);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-096");
      }
      const form = await withOwnerProofReasonAsync(
        "evidence-097",
        async () =>
          await new Response(new Uint8Array(bytes).buffer, {
            headers: {
              "Content-Type": `multipart/form-data; boundary=${line.slice(2)}`,
            },
          }).formData(),
      );
      const metadata = form.get("metadata");
      try {
        assert.equal(typeof metadata, "string");
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-098");
      }
      const info = withOwnerProofReason("evidence-099", () =>
        JSON.parse(metadata as string),
      );
      try {
        assert.equal(info.main_module, "data-api.js");
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-100");
      }
      try {
        assert.equal(info.compatibility_date, "2026-06-06");
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-101");
      }
      try {
        assert.deepEqual(info.compatibility_flags, ["nodejs_compat"]);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-102");
      }
      const types = {
        "application/javascript+module": "ESModule",
        "application/javascript": "CommonJS",
        "application/wasm": "CompiledWasm",
        "application/octet-stream": "Data",
        "text/plain": "Text",
      };
      const seen = new Set<string>(),
        maps: Record<string, unknown>[] = [];
      proofStage = "queue-modules";
      for (const [name, value] of form) {
        if (name === "metadata") continue;
        try {
          assert.notEqual(typeof value, "string");
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-103");
        }
        const file = value as File;
        if (file.type === "application/source-map") {
          try {
            assert.ok(file.size <= OWNER_BUILD_LIMITS.associationBytes);
          } catch (cause) {
            throw ownerProofFailure(cause, "evidence-104");
          }
          maps.push(
            await withOwnerProofReasonAsync("evidence-105", async () =>
              JSON.parse(await file.text()),
            ),
          );
          continue;
        }
        try {
          assert.ok(!seen.has(name));
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-106");
        }
        seen.add(name);
        const expected = manifest.modules.find(
          (module) => module.name === name,
        );
        try {
          assert.ok(expected);
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-107");
        }
        try {
          assert.equal(expected.type, types[file.type as keyof typeof types]);
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-108");
        }
        try {
          assert.deepEqual(
            Buffer.from(await file.arrayBuffer()),
            moduleBytes(name),
          );
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-109");
        }
      }
      try {
        assert.deepEqual(
          [...seen].sort(),
          manifest.modules.map((module) => module.name).sort(),
        );
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-110");
      }
      proofStage = "queue-source-maps";
      try {
        assert.ok(maps.length > 0 && maps.length <= 256);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-111");
      }
      const actualSources = manifest.sources
        .map((source) => source.path)
        .filter((source) => source !== "wrangler.data.jsonc");
      for (const map of maps) matchSources(map, actualSources);
      for (const required of requiredSources.queue.filter(
        (source) => source !== "wrangler.data.jsonc",
      ))
        try {
          assert.ok(
            maps.some((map) =>
              (map.sources as string[]).some(
                (source) =>
                  source === required ||
                  source.replaceAll("\\", "/").endsWith("/" + required),
              ),
            ),
            "Required genuine bundle source association missing",
          );
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-112");
        }
      return;
    }
    proofStage = "raw-envelope";
    const association = withOwnerProofReason("evidence-113", () =>
      JSON.parse(bytes.toString()),
    );
    try {
      assert.equal(association.kind, "esbuild-api");
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-114");
    }
    try {
      assert.equal(association.sourceRoot, realpathSync(root));
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-115");
    }
    try {
      assert.equal(
        association.dependencyRoot,
        realpathSync(path.join(root, "node_modules")),
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-116");
    }
    try {
      assert.ok(
        typeof association.outputRoot === "string" &&
          path.isAbsolute(association.outputRoot),
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-117");
    }
    try {
      assert.match(
        association.outputRoot,
        /\/raw-owner-qualification-[A-Za-z0-9]+\/modules$/,
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-118");
    }
    try {
      assert.ok(
        Array.isArray(association.outputs) &&
          association.outputs.length <= 1024,
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-119");
    }
    try {
      assert.ok(
        Array.isArray(association.sourceMaps) &&
          association.sourceMaps.length <= 512,
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-120");
    }
    const meta = association.metafile;
    try {
      assert.ok(
        meta &&
          typeof meta.inputs === "object" &&
          typeof meta.outputs === "object",
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-121");
    }
    const inputs = Object.keys(meta.inputs);
    try {
      assert.ok(inputs.length > 0 && inputs.length <= 8192);
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-122");
    }
    proofStage = "raw-inputs";
    const knownSources = new Set(manifest.sources.map((source) => source.path));
    const inputIdentities = new Set<string>();
    for (const name of inputs) {
      if (name.startsWith("native-node-require:")) {
        try {
          assert.match(name, /^native-node-require:[A-Za-z0-9_/-]+$/);
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-123");
        }
        try {
          assert.ok(isBuiltin(name.slice("native-node-require:".length)));
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-124");
        }
        continue;
      }
      const relative = ownerBuildInputIdentity(
        association.sourceRoot,
        association.dependencyRoot,
        name,
      );
      try {
        assert.ok(!inputIdentities.has(relative), "Duplicate input identity");
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-125");
      }
      inputIdentities.add(relative);
      try {
        assert.ok(knownSources.has(relative));
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-126");
      }
      try {
        assert.equal(
          meta.inputs[name].bytes,
          boundedBuildFile(sourceFile(root, relative), 32 * 1024 * 1024)
            .byteLength,
        );
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-127");
      }
    }
    proofStage = "raw-output-inventory";
    const outputNames = new Map<string, string>();
    for (const name of Object.keys(meta.outputs)) {
      const absolute = path.resolve(root, name);
      try {
        assert.ok(absolute.startsWith(association.outputRoot + path.sep));
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-128");
      }
      const relative = path.relative(association.outputRoot, absolute);
      relativeName(relative);
      try {
        assert.ok(!outputNames.has(relative));
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-129");
      }
      outputNames.set(relative, name);
    }
    try {
      assert.equal(outputNames.size, association.outputs.length);
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-130");
    }
    proofStage = "raw-source-maps";
    const maps = new Map<string, Record<string, unknown>>();
    for (const map of association.sourceMaps) {
      relativeName(map.name);
      try {
        assert.ok(map.name.endsWith(".js.map") && !maps.has(map.name));
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-131");
      }
      try {
        assert.equal(typeof map.base64, "string");
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-132");
      }
      const decoded = Buffer.from(map.base64, "base64");
      try {
        assert.equal(decoded.toString("base64"), map.base64);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-133");
      }
      try {
        assert.ok(decoded.length <= OWNER_BUILD_LIMITS.associationBytes);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-134");
      }
      const parsed = withOwnerProofReason("evidence-135", () =>
        JSON.parse(decoded.toString()),
      );
      matchSources(parsed, [...knownSources]);
      maps.set(map.name, parsed);
      try {
        assert.equal(
          meta.outputs[outputNames.get(map.name)!]?.bytes,
          decoded.length,
        );
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-136");
      }
    }
    proofStage = "optional-proof";
    const optionalPg = optionalPgBuildAssociation(
      root,
      association.outputRoot,
      meta,
      association.outputs
        .filter((output: { type: string }) => output.type === "ESModule")
        .map(
          (output: {
            name: string;
            metafilePath: string;
            sourceMapName: string;
          }) => {
            const map = association.sourceMaps.find(
              (row: { name: string }) => row.name === output.sourceMapName,
            );
            try {
              assert.ok(map);
            } catch (cause) {
              throw ownerProofFailure(cause, "evidence-137");
            }
            const mapPath = outputNames.get(output.sourceMapName);
            try {
              assert.ok(mapPath);
            } catch (cause) {
              throw ownerProofFailure(cause, "evidence-138");
            }
            return {
              metafilePath: output.metafilePath,
              bytes: moduleBytes(output.name),
              sourceMap: {
                metafilePath: mapPath,
                bytes: Buffer.from(map.base64, "base64"),
              },
            };
          },
        ),
      manifest.modules.map((module) => module.name),
    );
    proofStage = "raw-modules";
    const seen = new Set<string>(),
      edges: { from: string; to: string; dynamic: boolean }[] = [];
    for (const output of association.outputs) {
      relativeName(output.name);
      try {
        assert.ok(!seen.has(output.name));
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-139");
      }
      seen.add(output.name);
      try {
        assert.equal(output.metafilePath, outputNames.get(output.name));
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-140");
      }
      const info = meta.outputs[output.metafilePath];
      try {
        assert.ok(info);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-141");
      }
      if (output.type === "SourceMap") {
        try {
          assert.ok(maps.has(output.name));
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-142");
        }
        try {
          assert.equal(output.sourceMapName, null);
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-143");
        }
        const sourceMap = association.sourceMaps.find(
          (row: { name: string }) => row.name === output.name,
        );
        try {
          assert.equal(
            output.sha256,
            hash(Buffer.from(sourceMap.base64, "base64")),
          );
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-144");
        }
        continue;
      }
      try {
        assert.ok(output.type === "ESModule" || output.type === "CompiledWasm");
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-145");
      }
      const registered = manifest.modules.find(
        (module) => module.name === output.name,
      );
      try {
        assert.ok(registered);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-146");
      }
      try {
        assert.equal(registered.type, output.type);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-147");
      }
      try {
        assert.equal(info.bytes, registered.bytes);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-148");
      }
      try {
        assert.equal(output.sha256, hash(moduleBytes(output.name)));
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-149");
      }
      if (output.type === "ESModule") {
        try {
          assert.equal(output.sourceMapName, output.name + ".map");
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-150");
        }
        try {
          assert.ok(maps.has(output.sourceMapName));
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-151");
        }
      } else {
        try {
          assert.equal(output.sourceMapName, null);
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-152");
        }
        try {
          assert.deepEqual(
            [...moduleBytes(output.name).subarray(0, 8)],
            [0, 97, 115, 109, 1, 0, 0, 0],
          );
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-153");
        }
      }
      try {
        assert.ok(Array.isArray(info.imports));
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-154");
      }
      for (const [importIndex, dependency] of info.imports.entries()) {
        if (dependency.external) {
          if (
            optionalPg &&
            optionalPg.admitted.output === output.metafilePath &&
            optionalPg.admitted.importIndex === importIndex
          )
            continue;
          assertOwnerExternalImport(dependency.path);
          continue;
        }
        const candidates = [
          ...new Set([
            path.resolve(root, dependency.path),
            path.resolve(
              association.outputRoot,
              path.dirname(output.name),
              dependency.path,
            ),
          ]),
        ]
          .map((candidate) => path.relative(association.outputRoot, candidate))
          .filter((candidate) => outputNames.has(candidate));
        try {
          assert.equal(candidates.length, 1);
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-155");
        }
        edges.push({
          from: output.name,
          to: candidates[0]!,
          dynamic: dependency.kind === "dynamic-import",
        });
      }
    }
    try {
      assert.deepEqual([...seen].sort(), [...outputNames.keys()].sort());
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-156");
    }
    try {
      assert.deepEqual(
        association.outputs
          .filter((output: { type: string }) => output.type !== "SourceMap")
          .map((output: { name: string }) => output.name)
          .sort(),
        manifest.modules.map((module) => module.name).sort(),
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-157");
    }
    proofStage = "raw-closure";
    const entryInfo = meta.outputs[outputNames.get("api.entry.js")!];
    try {
      assert.equal(entryInfo.entryPoint, "workers/api.entry.ts");
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-158");
    }
    try {
      assert.deepEqual([...entryInfo.exports].sort(), [
        "AlerterHub",
        "ChainFirehoseHub",
        "McpSessionHub",
        "NeonWriteBufferHub",
        "SubnetStatusHub",
        "default",
      ]);
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-159");
    }
    const closure = (dynamic: boolean) => {
      const reached = new Set(["api.entry.js"]);
      for (let previous = -1; previous !== reached.size;) {
        previous = reached.size;
        for (const edge of edges)
          if (reached.has(edge.from) && (dynamic || !edge.dynamic))
            reached.add(edge.to);
      }
      return reached;
    };
    try {
      assert.deepEqual(
        [...closure(true)].sort(),
        manifest.modules.map((module) => module.name).sort(),
      );
    } catch (cause) {
      throw ownerProofFailure(cause, "evidence-160");
    }
    const eager = closure(false);
    proofStage = "raw-contributions";
    for (const required of [
      "workers/api.entry.ts",
      "workers/api.ts",
      "src/raw-capture-sync.ts",
      "src/raw-chain-capture.ts",
      "src/raw-capture-d1.ts",
    ]) {
      const names = inputs.filter(
        (name) => path.resolve(root, name) === path.join(root, required),
      );
      try {
        assert.equal(names.length, 1);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-161");
      }
      const contributions = Object.entries(meta.outputs).filter(
        ([, output]) =>
          ((output as { inputs: Record<string, { bytesInOutput: number }> })
            .inputs[names[0]!]?.bytesInOutput ?? 0) > 0,
      );
      try {
        assert.ok(contributions.length > 0);
      } catch (cause) {
        throw ownerProofFailure(cause, "evidence-162");
      }
      for (const [output] of contributions) {
        const relative = path.relative(
          association.outputRoot,
          path.resolve(root, output),
        );
        const map = maps.get(relative + ".map");
        try {
          assert.ok(map);
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-163");
        }
        const matches = (map.sources as string[]).flatMap((source, index) =>
          source === required ||
          source.replaceAll("\\", "/").endsWith("/" + required)
            ? [index]
            : [],
        );
        try {
          assert.ok(matches.length > 0);
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-164");
        }
        for (const index of matches)
          try {
            assert.equal(
              (map.sourcesContent as unknown[])[index],
              boundedBuildFile(
                sourceFile(root, required),
                32 * 1024 * 1024,
              ).toString(),
            );
          } catch (cause) {
            throw ownerProofFailure(cause, "evidence-165");
          }
      }
      if (required === "workers/api.ts")
        try {
          assert.ok(
            contributions.every(
              ([output]) =>
                !eager.has(
                  path.relative(
                    association.outputRoot,
                    path.resolve(root, output),
                  ),
                ),
            ),
          );
        } catch (cause) {
          throw ownerProofFailure(cause, "evidence-166");
        }
    }
  } catch (cause) {
    throw ownerBuildStageFailure("association", proofStage, cause);
  }
}
