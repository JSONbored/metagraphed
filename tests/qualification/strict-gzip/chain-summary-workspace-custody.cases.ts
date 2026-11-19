import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  fixture,
  metadata,
  DIST,
  SOURCE_A,
  SOURCE_B,
} from "./chain-summary-workspace-fixture.ts";
import {
  CHAIN_SUMMARY_WORKSPACE_PINS,
  CHAIN_SUMMARY_WORKSPACE_EDGES,
  WORKSPACE_CUSTODY_LIMITS,
  readChainSummaryWorkspaceCustody,
  hasChainSummaryWorkspaceInput,
  chainSummaryWorkspaceInputIdentity,
  chainSummaryWorkspaceSource,
} from "./chain-summary-workspace-custody.ts";
import { ownerProofReasonMarker } from "./owner-proof-reasons.ts";
function ready() {
  const f = fixture();
  const actual = path.relative(f.root, path.join(f.base, DIST));
  f.meta.outputs = {
    "out.js": { imports: [], inputs: { [actual]: { bytesInOutput: 1 } } },
    "out.js.map": { imports: [], inputs: {} },
  };
  return { ...f, actual };
}
function expectReason(action: () => unknown, code?: string) {
  assert.throws(action, (error) => {
    const marker = ownerProofReasonMarker(error);
    assert.ok(marker.startsWith("[owner-proof-reason:wsc-"), marker);
    if (code) assert.equal(marker, `[owner-proof-reason:${code}]`);
    return true;
  });
}
test("workspace custody constants and physical branded identity are immutable", () => {
  const f = ready();
  try {
    const token = readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta)!;
    assert.ok(Object.isFrozen(token));
    assert.ok(Object.isFrozen(CHAIN_SUMMARY_WORKSPACE_PINS));
    assert.ok(Object.isFrozen(CHAIN_SUMMARY_WORKSPACE_EDGES));
    assert.ok(Object.isFrozen(WORKSPACE_CUSTODY_LIMITS));
    assert.equal(hasChainSummaryWorkspaceInput(f.root, f.dep, f.meta), true);
    assert.equal(
      chainSummaryWorkspaceInputIdentity(
        token,
        f.root,
        f.dep,
        f.meta,
        f.actual,
      ),
      DIST,
    );
    assert.equal(
      chainSummaryWorkspaceInputIdentity(
        token,
        f.root,
        f.dep,
        f.meta,
        SOURCE_A,
      ),
      null,
    );
    assert.deepEqual(
      chainSummaryWorkspaceSource(token, f.root, f.dep, f.meta),
      {
        logical: DIST,
        actual: f.actual,
        canonicalFile: path.join(f.base, DIST),
        bytes: 31640,
        sha256: CHAIN_SUMMARY_WORKSPACE_PINS[DIST].sha256,
      },
    );
  } finally {
    f.clean();
  }
});
test("no special key leaves legacy no-import and absolute-output graph untouched without reads", () => {
  let calls = 0;
  const old = fs.lstatSync;
  (fs as { lstatSync: typeof fs.lstatSync }).lstatSync = (() => {
    calls++;
    throw new Error("private");
  }) as typeof fs.lstatSync;
  try {
    const meta = {
      inputs: { "src/a.ts": { bytes: 1 } },
      outputs: { "/tmp/legacy.js": { bytes: 1 } },
    };
    assert.equal(
      hasChainSummaryWorkspaceInput("/candidate", "/base/node_modules", meta),
      false,
    );
    assert.equal(
      readChainSummaryWorkspaceCustody(
        "/candidate",
        "/base/node_modules",
        meta,
      ),
      null,
    );
    assert.equal(calls, 0);
  } finally {
    (fs as { lstatSync: typeof fs.lstatSync }).lstatSync = old;
  }
});
test("candidate-local workspace path has no special escaped identity", () => {
  const meta = metadata("/root", "/root/node_modules");
  assert.equal(
    hasChainSummaryWorkspaceInput("/root", "/root/node_modules", meta),
    false,
  );
  assert.equal(
    readChainSummaryWorkspaceCustody("/root", "/root/node_modules", meta),
    null,
  );
});
const metaMutations: [string, (f: ReturnType<typeof ready>) => void][] = [
  [
    "removed dist",
    (f) => {
      delete f.meta.inputs[f.actual];
    },
  ],
  [
    "altered dist bytes",
    (f) => {
      f.meta.inputs[f.actual].bytes++;
    },
  ],
  [
    "added dist import",
    (f) => {
      f.meta.inputs[f.actual].imports.push({
        path: "node:fs",
        kind: "import-statement",
        external: true,
      });
    },
  ],
  [
    "first edge target",
    (f) => {
      f.meta.inputs[SOURCE_A].imports[8].path = "src/other.ts";
    },
  ],
  [
    "second edge kind",
    (f) => {
      f.meta.inputs[SOURCE_B].imports[10].kind = "require-call";
    },
  ],
  [
    "edge original",
    (f) => {
      f.meta.inputs[SOURCE_A].imports[8].original = "private-target";
    },
  ],
  [
    "edge external",
    (f) => {
      f.meta.inputs[SOURCE_A].imports[8].external = true;
    },
  ],
  [
    "edge index",
    (f) => {
      f.meta.inputs[SOURCE_A].imports.unshift({
        path: "node:fs",
        kind: "import-statement",
        external: true,
      });
    },
  ],
  [
    "third incoming edge",
    (f) => {
      f.meta.inputs[SOURCE_A].imports.push({
        ...f.meta.inputs[SOURCE_A].imports[8],
      });
    },
  ],
  [
    "importer bytes",
    (f) => {
      f.meta.inputs[SOURCE_B].bytes++;
    },
  ],
  [
    "candidate alias",
    (f) => {
      f.meta.inputs[DIST] = { bytes: 31640, imports: [] };
    },
  ],
  [
    "logical package alias",
    (f) => {
      f.meta.inputs["node_modules/@jsonbored/chain-summaries/dist/index.js"] = {
        bytes: 31640,
        imports: [],
      };
    },
  ],
  [
    "canonical package alias",
    (f) => {
      f.meta.inputs[
        path.relative(
          f.root,
          path.join(f.dep, "@jsonbored/chain-summaries/dist/index.js"),
        )
      ] = { bytes: 31640, imports: [] };
    },
  ],
  [
    "another escaped input",
    (f) => {
      f.meta.inputs["../private/file.ts"] = { bytes: 1, imports: [] };
    },
  ],
  [
    "noncanonical input",
    (f) => {
      f.meta.inputs["./src/new.ts"] = { bytes: 1, imports: [] };
    },
  ],
  [
    "secret URL input",
    (f) => {
      f.meta.inputs["https://private.invalid/token"] = {
        bytes: 1,
        imports: [],
      };
    },
  ],
  [
    "disabled namespace",
    (f) => {
      f.meta.inputs["(disabled):private"] = { bytes: 1, imports: [] };
    },
  ],
  [
    "invalid builtin namespace",
    (f) => {
      f.meta.inputs["native-node-require:private"] = { bytes: 1, imports: [] };
    },
  ],
  [
    "new ordinary input",
    (f) => {
      f.meta.inputs["src/new.ts"] = { bytes: 1, imports: [] };
    },
  ],
  [
    "changed ordinary import",
    (f) => {
      f.meta.inputs[SOURCE_A].imports[0].path = "node:path";
    },
  ],
  [
    "renamed output",
    (f) => {
      f.meta.outputs["other.js"] = f.meta.outputs["out.js"];
      delete f.meta.outputs["out.js"];
    },
  ],
  [
    "changed output contribution",
    (f) => {
      f.meta.outputs["out.js"].inputs[f.actual].bytesInOutput = 2;
    },
  ],
  [
    "removed output contribution",
    (f) => {
      delete f.meta.outputs["out.js"].inputs[f.actual];
    },
  ],
  [
    "added zero map contribution",
    (f) => {
      f.meta.outputs["out.js.map"].inputs[f.actual] = { bytesInOutput: 0 };
    },
  ],
  [
    "added wasm contribution",
    (f) => {
      f.meta.outputs["out.wasm"] = {
        imports: [],
        inputs: { [f.actual]: { bytesInOutput: 1 } },
      };
    },
  ],
  [
    "negative contribution",
    (f) => {
      f.meta.outputs["out.js"].inputs[f.actual].bytesInOutput = -1;
    },
  ],
  [
    "unsafe contribution",
    (f) => {
      f.meta.outputs["out.js"].inputs[f.actual].bytesInOutput =
        Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "unknown contribution",
    (f) => {
      f.meta.outputs["out.js"].inputs["src/unknown.ts"] = { bytesInOutput: 1 };
    },
  ],
];
for (const [name, mutate] of metaMutations)
  test(`minted custody refuses metadata mutation: ${name}`, () => {
    const f = ready();
    try {
      const token = readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta)!;
      mutate(f);
      expectReason(() =>
        chainSummaryWorkspaceSource(token, f.root, f.dep, f.meta),
      );
    } finally {
      f.clean();
    }
  });
for (const [name, mutate] of metaMutations.filter(
  ([name]) =>
    ![
      "removed dist",
      "new ordinary input",
      "changed ordinary import",
      "renamed output",
      "changed output contribution",
      "removed output contribution",
    ].includes(name),
))
  test(`invalid workspace graph refuses before filesystem reads: ${name}`, () => {
    const f = ready();
    try {
      mutate(f);
      let calls = 0;
      const old = fs.lstatSync;
      (fs as { lstatSync: typeof fs.lstatSync }).lstatSync = (() => {
        calls++;
        throw new Error("private");
      }) as typeof fs.lstatSync;
      try {
        expectReason(() =>
          readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta),
        );
        assert.equal(calls, 0);
      } finally {
        (fs as { lstatSync: typeof fs.lstatSync }).lstatSync = old;
      }
    } finally {
      f.clean();
    }
  });
for (const forged of [
  { kind: "pending-chain-summary-workspace-custody" },
  Object.freeze({}),
  null,
  undefined,
])
  test("unbranded workspace descriptor is refused", () => {
    const f = ready();
    try {
      expectReason(() =>
        chainSummaryWorkspaceSource(forged, f.root, f.dep, f.meta),
      );
    } finally {
      f.clean();
    }
  });
test("copied, cross-root and cross-metafile custody objects are refused", () => {
  const f = ready();
  try {
    const token = readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta)!;
    expectReason(
      () => chainSummaryWorkspaceSource({ ...token }, f.root, f.dep, f.meta),
      "wsc-047",
    );
    expectReason(
      () => chainSummaryWorkspaceSource(token, f.base, f.dep, f.meta),
      "wsc-047",
    );
    expectReason(
      () =>
        chainSummaryWorkspaceSource(
          token,
          f.root,
          f.dep,
          structuredClone(f.meta),
        ),
      "wsc-047",
    );
  } finally {
    f.clean();
  }
});
for (const position of [
  "meta",
  "inputs",
  "record",
  "imports",
  "row",
  "outputs",
  "contributions",
] as const)
  test(`proxy refuses without trap: ${position}`, () => {
    const f = ready();
    let calls = 0;
    try {
      const proxy = new Proxy(
        {},
        new Proxy(
          {},
          {
            get() {
              return () => {
                calls++;
                throw new Error("private");
              };
            },
          },
        ),
      );
      if (position === "meta") f.meta = proxy;
      else if (position === "inputs") f.meta.inputs = proxy;
      else if (position === "record") f.meta.inputs[f.actual] = proxy;
      else if (position === "imports") f.meta.inputs[SOURCE_A].imports = proxy;
      else if (position === "row") f.meta.inputs[SOURCE_A].imports[8] = proxy;
      else if (position === "outputs") f.meta.outputs = proxy;
      else f.meta.outputs["out.js"].inputs = proxy;
      expectReason(() =>
        readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta),
      );
      assert.equal(calls, 0);
    } finally {
      f.clean();
    }
  });
for (const position of ["inputs", "record", "row", "contribution"] as const)
  test(`accessor refuses without call: ${position}`, () => {
    const f = ready();
    let calls = 0;
    try {
      const getter = {
        enumerable: true,
        get() {
          calls++;
          throw new Error("private");
        },
      };
      if (position === "inputs")
        Object.defineProperty(f.meta, "inputs", getter);
      else if (position === "record")
        Object.defineProperty(f.meta.inputs, f.actual, getter);
      else if (position === "row")
        Object.defineProperty(
          f.meta.inputs[SOURCE_A].imports[8],
          "path",
          getter,
        );
      else
        Object.defineProperty(
          f.meta.outputs["out.js"].inputs[f.actual],
          "bytesInOutput",
          getter,
        );
      expectReason(() =>
        readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta),
      );
      assert.equal(calls, 0);
    } finally {
      f.clean();
    }
  });
for (const [name, pin] of Object.entries(CHAIN_SUMMARY_WORKSPACE_PINS))
  for (const location of name.startsWith("src/")
    ? (["root"] as const)
    : (["root", "base"] as const))
    test(`fresh custody rejects changed pinned file: ${location}/${name}`, () => {
      const f = ready();
      try {
        readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta);
        const filename = path.join(f[location], name),
          bytes = fs.readFileSync(filename);
        bytes[0] ^= 1;
        fs.writeFileSync(filename, bytes);
        expectReason(
          () => readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta),
          "wsc-043",
        );
        assert.equal(bytes.length, pin.bytes);
      } finally {
        f.clean();
      }
    });
for (const which of ["candidate", "workspace"] as const)
  test(`fresh custody refuses changed ${which} link`, () => {
    const f = ready();
    try {
      readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta);
      const link =
        which === "candidate"
          ? path.join(f.root, "node_modules")
          : path.join(f.dep, "@jsonbored/chain-summaries");
      const target =
        which === "candidate"
          ? path.relative(f.root, f.dep)
          : path.join(f.base, "packages/chain-summaries");
      fs.unlinkSync(link);
      fs.symlinkSync(target, link);
      expectReason(
        () => readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta),
        which === "candidate" ? "wsc-039" : "wsc-040",
      );
    } finally {
      f.clean();
    }
  });
test("pin bound rejects oversized file before open", () => {
  const f = ready();
  try {
    fs.appendFileSync(path.join(f.base, DIST), "x");
    let count = 0;
    const old = fs.openSync;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === path.join(f.base, DIST)) count++;
      return old(...args);
    }) as typeof fs.openSync;
    try {
      expectReason(
        () => readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta),
        "wsc-034",
      );
      assert.equal(count, 0);
    } finally {
      fs.openSync = old;
    }
  } finally {
    f.clean();
  }
});
test("every custody read is nonblocking and nofollow", () => {
  const f = ready();
  try {
    let count = 0;
    const old = fs.openSync;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      assert.equal(typeof args[1], "number");
      assert.ok((args[1] as number) & fs.constants.O_NONBLOCK);
      assert.ok((args[1] as number) & fs.constants.O_NOFOLLOW);
      count++;
      return old(...args);
    }) as typeof fs.openSync;
    try {
      readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta);
      assert.equal(count, 10);
    } finally {
      fs.openSync = old;
    }
  } finally {
    f.clean();
  }
});
test("graph mutation during fixed reads refuses mint", () => {
  const f = ready();
  try {
    const old = fs.readSync;
    let changed = false;
    fs.readSync = ((...args: any[]) => {
      if (!changed) {
        changed = true;
        f.meta.outputs["out.js"].inputs[f.actual].bytesInOutput++;
      }
      return (old as any)(...args);
    }) as typeof fs.readSync;
    try {
      expectReason(
        () => readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta),
        "wsc-045",
      );
    } finally {
      fs.readSync = old;
    }
  } finally {
    f.clean();
  }
});
test("key-only scan refuses oversized and aggregate-overbudget input names before reads", () => {
  const large = {
    inputs: Object.fromEntries(
      Array.from({ length: 4200 }, (_, i) => [
        "src/" + i + "x".repeat(4080),
        { bytes: 0, imports: [] },
      ]),
    ),
  };
  expectReason(
    () =>
      readChainSummaryWorkspaceCustody(
        "/candidate",
        "/base/node_modules",
        large,
      ),
    "wsc-055",
  );
  expectReason(
    () =>
      hasChainSummaryWorkspaceInput("/candidate", "/base/node_modules", {
        inputs: { ["x".repeat(4097)]: {} },
      }),
    "wsc-054",
  );
});
test("output key strings count against the whole fingerprint budget immediately", () => {
  const f = ready();
  try {
    const rows = f.meta.inputs[SOURCE_A].imports;
    for (let i = 0; i < 3900; i++)
      rows.push({
        path: "opaque:" + "x".repeat(3990),
        kind: "import-statement",
        external: true,
      });
    f.meta.outputs = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [
        "out/" + i + "x".repeat(3990) + ".js",
        { imports: [], inputs: {} },
      ]),
    );
    expectReason(
      () => readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta),
      "wsc-053",
    );
  } finally {
    f.clean();
  }
});
for (const scope of ["input", "output"] as const)
  for (const mode of [
    "entries",
    "iterator",
    "prototype",
    "hole",
    "extra-index",
  ] as const)
    for (const phase of ["mint", "refresh"] as const)
      test(`strict ${scope} import array rejects ${mode} at ${phase} without side effects`, () => {
        const f = ready();
        let calls = 0;
        try {
          const token =
            phase === "refresh"
              ? readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta)
              : null;
          const array =
            scope === "input"
              ? f.meta.inputs[SOURCE_A].imports
              : f.meta.outputs["out.js"].imports;
          if (mode === "entries")
            Object.defineProperty(array, "entries", {
              get() {
                calls++;
                throw new Error("private");
              },
            });
          else if (mode === "iterator")
            Object.defineProperty(array, Symbol.iterator, {
              get() {
                calls++;
                throw new Error("private");
              },
            });
          else if (mode === "prototype")
            Object.setPrototypeOf(array, Object.create(Array.prototype));
          else if (mode === "hole") {
            array.length++;
          } else
            Object.defineProperty(array, "01", {
              value: {
                path: "node:fs",
                kind: "import-statement",
                external: true,
              },
            });
          expectReason(() =>
            phase === "mint"
              ? readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta)
              : chainSummaryWorkspaceSource(token, f.root, f.dep, f.meta),
          );
          assert.equal(calls, 0);
        } finally {
          f.clean();
        }
      });
test("normalized third incoming edge cannot escape the exact incoming inventory", () => {
  const f = ready();
  try {
    f.meta.inputs[SOURCE_A].imports.push({
      path: f.actual.replace("/dist/", "/dist/./"),
      kind: "import-statement",
      original: "@jsonbored/chain-summaries",
    });
    expectReason(
      () => readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta),
      "wsc-022",
    );
  } finally {
    f.clean();
  }
});
for (const field of ["path", "kind", "external", "original"] as const)
  test(`output import ${field} accessor is rejected before reads`, () => {
    const f = ready();
    let calls = 0;
    try {
      const row = { path: "node:fs", kind: "import-statement", external: true };
      Object.defineProperty(row, field, {
        enumerable: true,
        get() {
          calls++;
          throw new Error("private");
        },
      });
      f.meta.outputs["out.js"].imports.push(row);
      expectReason(() =>
        readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta),
      );
      assert.equal(calls, 0);
    } finally {
      f.clean();
    }
  });
for (const scope of ["input", "output"] as const)
  for (const attack of ["path-getter", "proxy-row"] as const)
    for (const phase of ["mint", "refresh"] as const)
      test(`${scope} ${attack} refuses at ${phase} with zero callbacks`, () => {
        const f = ready();
        let calls = 0;
        try {
          if (scope === "output")
            f.meta.outputs["out.js"].imports.push({
              path: "node:fs",
              kind: "import-statement",
              external: true,
            });
          const token =
            phase === "refresh"
              ? readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta)
              : null;
          const array =
            scope === "input"
              ? f.meta.inputs[SOURCE_A].imports
              : f.meta.outputs["out.js"].imports;
          if (attack === "path-getter")
            Object.defineProperty(array[0], "path", {
              enumerable: true,
              get() {
                calls++;
                throw new Error("private");
              },
            });
          else
            array[0] = new Proxy(array[0], {
              get() {
                calls++;
                throw new Error("private");
              },
              ownKeys() {
                calls++;
                throw new Error("private");
              },
              getOwnPropertyDescriptor() {
                calls++;
                throw new Error("private");
              },
              getPrototypeOf() {
                calls++;
                throw new Error("private");
              },
            });
          expectReason(() =>
            phase === "mint"
              ? readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta)
              : chainSummaryWorkspaceSource(token, f.root, f.dep, f.meta),
          );
          assert.equal(calls, 0);
        } finally {
          f.clean();
        }
      });
test("adding an ordinary output import after mint invalidates fingerprint", () => {
  const f = ready();
  try {
    const token = readChainSummaryWorkspaceCustody(f.root, f.dep, f.meta);
    f.meta.outputs["out.js"].imports.push({
      path: "node:fs",
      kind: "import-statement",
      external: true,
    });
    expectReason(
      () => chainSummaryWorkspaceSource(token, f.root, f.dep, f.meta),
      "wsc-048",
    );
  } finally {
    f.clean();
  }
});
