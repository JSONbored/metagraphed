import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  CHAIN_SUMMARY_WORKSPACE_PINS,
  CHAIN_SUMMARY_WORKSPACE_LIMITS,
  CHAIN_SUMMARY_WORKSPACE_STATUSES,
  probeChainSummaryWorkspaceIdentity,
  chainSummaryWorkspaceMarker,
  parseChainSummaryWorkspaceMarker,
} from "./chain-summary-workspace-probe.ts";
import {
  fixture,
  metadata,
  sourceBytes,
  DIST,
  SOURCE_A,
  SOURCE_B,
  placeholder,
} from "./chain-summary-workspace-fixture.ts";
function useFixture(action: (value: ReturnType<typeof fixture>) => void) {
  const value = fixture();
  try {
    action(value);
  } finally {
    value.clean();
  }
}
function noFileCalls(action: () => void) {
  let calls = 0;
  const names = [
    "lstatSync",
    "realpathSync",
    "readlinkSync",
    "openSync",
    "readFileSync",
  ] as const;
  const before = names.map((name) => [name, fs[name]] as const);
  try {
    for (const name of names)
      (fs as any)[name] = () => {
        calls++;
        throw new Error("unexpected fixed-file read");
      };
    action();
    assert.equal(calls, 0);
  } finally {
    for (const [name, fn] of before) (fs as any)[name] = fn;
  }
}
const nonexistingRoot = "/workspace-fixed-probe/candidate",
  nonexistingDep = "/workspace-fixed-probe/base/node_modules";
const empty = {
  version: 1,
  identity: "chain-summaries-dist",
  status: "scan-refused",
  inputScanComplete: false,
  inputCount: 0,
  escapedCount: 0,
  exactMatches: 0,
  otherEscapedCount: 0,
  matchedEdges: 0,
};
const identified = {
  version: 1,
  identity: "chain-summaries-dist",
  status: "identified",
  inputScanComplete: true,
  inputCount: 3,
  escapedCount: 1,
  exactMatches: 1,
  otherEscapedCount: 0,
  matchedEdges: 2,
};
const probe = (f: ReturnType<typeof fixture>) =>
  probeChainSummaryWorkspaceIdentity(f.root, f.dep, f.meta);

test("fixed public fixture and immutable pins match exact Git blobs", () => {
  assert.ok(Object.isFrozen(CHAIN_SUMMARY_WORKSPACE_STATUSES));
  assert.ok(Object.isFrozen(CHAIN_SUMMARY_WORKSPACE_PINS));
  assert.ok(Object.isFrozen(CHAIN_SUMMARY_WORKSPACE_LIMITS));
  assert.deepEqual(
    Object.keys(sourceBytes).sort(),
    Object.keys(CHAIN_SUMMARY_WORKSPACE_PINS).sort(),
  );
  for (const [name, pin] of Object.entries(CHAIN_SUMMARY_WORKSPACE_PINS)) {
    assert.ok(Object.isFrozen(pin));
    const bytes = Buffer.from(sourceBytes[name]!);
    assert.equal(bytes.length, pin.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.sha256);
    assert.equal(
      createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex"),
      pin.gitBlob,
    );
  }
});
test("exact original workspace key, two edges and fixed public bytes are identified", () =>
  useFixture((f) => {
    assert.deepEqual(probe(f), identified);
    assert.deepEqual(
      parseChainSummaryWorkspaceMarker(chainSummaryWorkspaceMarker(probe(f))),
      identified,
    );
  }));
test("complete probe counts include ordinary dependencies and valid builtins", () =>
  useFixture((f) => {
    f.meta.inputs["node_modules/example/index.js"] = { bytes: 1, imports: [] };
    f.meta.inputs["native-node-require:fs"] = { bytes: 1, imports: [] };
    assert.deepEqual(probe(f), { ...identified, inputCount: 5 });
  }));
test("no matching key keeps unknown outside paths private and does no file IO", () => {
  const meta = {
    inputs: { "../private/secret.js": { bytes: 1, imports: [] } },
  };
  noFileCalls(() => {
    const value = probeChainSummaryWorkspaceIdentity(
      nonexistingRoot,
      nonexistingDep,
      meta,
    );
    assert.deepEqual(value, {
      ...empty,
      status: "no-match",
      inputScanComplete: true,
      inputCount: 1,
      escapedCount: 1,
      otherEscapedCount: 1,
    });
    assert.ok(!JSON.stringify(value).includes("secret"));
  });
});
test("a candidate-local workspace path is not an escaped match with shared dependency topology", () => {
  const root = "/workspace-fixed-probe/root",
    dep = path.join(root, "node_modules");
  noFileCalls(() =>
    assert.deepEqual(
      probeChainSummaryWorkspaceIdentity(root, dep, metadata(root, dep)),
      { ...empty, status: "no-match", inputScanComplete: true, inputCount: 3 },
    ),
  );
});
test("an exact key plus another escaped key refuses before filesystem reads", () => {
  const meta = metadata(nonexistingRoot, nonexistingDep);
  meta.inputs["../other/private.js"] = { bytes: 1, imports: [] };
  noFileCalls(() =>
    assert.deepEqual(
      probeChainSummaryWorkspaceIdentity(nonexistingRoot, nonexistingDep, meta),
      {
        ...empty,
        status: "key-refused",
        inputScanComplete: true,
        inputCount: 4,
        escapedCount: 2,
        exactMatches: 1,
        otherEscapedCount: 1,
      },
    ),
  );
});
for (const [name, mutate] of [
  [
    "wrong index",
    (m: any) => {
      m.inputs[SOURCE_A].imports.unshift(placeholder());
    },
  ],
  [
    "wrong target",
    (m: any) => {
      m.inputs[SOURCE_A].imports[8].path = "../private/secret";
    },
  ],
  [
    "wrong original",
    (m: any) => {
      m.inputs[SOURCE_A].imports[8].original = "@private/secret";
    },
  ],
  [
    "external edge",
    (m: any) => {
      m.inputs[SOURCE_A].imports[8].external = true;
    },
  ],
  [
    "wrong kind",
    (m: any) => {
      m.inputs[SOURCE_A].imports[8].kind = "dynamic-import";
    },
  ],
  [
    "missing second edge",
    (m: any) => {
      m.inputs[SOURCE_B].imports.pop();
    },
  ],
  [
    "wrong importer bytes",
    (m: any) => {
      m.inputs[SOURCE_A].bytes++;
    },
  ],
  [
    "wrong dist bytes",
    (m: any) => {
      m.inputs[Object.keys(m.inputs)[0]!].bytes++;
    },
  ],
  [
    "dist dependency",
    (m: any) => {
      m.inputs[Object.keys(m.inputs)[0]!].imports.push(placeholder());
    },
  ],
] as const)
  test("graph association refuses " + name + " before fixed reads", () => {
    const meta = metadata(nonexistingRoot, nonexistingDep);
    mutate(meta);
    noFileCalls(() => {
      const report = probeChainSummaryWorkspaceIdentity(
        nonexistingRoot,
        nonexistingDep,
        meta,
      );
      assert.equal(report.status, "edge-refused");
      assert.equal(report.inputScanComplete, true);
      assert.equal(report.exactMatches, 1);
      assert.ok(
        parseChainSummaryWorkspaceMarker(chainSummaryWorkspaceMarker(report)),
      );
    });
  });
for (const [name, mutate] of [
  [
    "URL key",
    (m: any) => {
      m.inputs["https://private/secret"] = { bytes: 0, imports: [] };
    },
  ],
  [
    "disabled namespace",
    (m: any) => {
      m.inputs["(disabled):private/secret"] = { bytes: 0, imports: [] };
    },
  ],
  [
    "invalid builtin",
    (m: any) => {
      m.inputs["native-node-require:node:fs"] = { bytes: 0, imports: [] };
    },
  ],
  [
    "absolute key",
    (m: any) => {
      m.inputs["/private/secret"] = { bytes: 0, imports: [] };
    },
  ],
  [
    "noncanonical key",
    (m: any) => {
      m.inputs["apps//secret"] = { bytes: 0, imports: [] };
    },
  ],
  [
    "unknown flag",
    (m: any) => {
      m.inputs[SOURCE_A].imports[0].external = "secret";
    },
  ],
  [
    "unknown target",
    (m: any) => {
      m.inputs[SOURCE_A].imports[0].path = {
        toString() {
          throw 0;
        },
      };
    },
  ],
  [
    "sparse array",
    (m: any) => {
      delete m.inputs[SOURCE_A].imports[0];
    },
  ],
  [
    "oversized target",
    (m: any) => {
      m.inputs[SOURCE_A].imports[0].path = "x".repeat(4097);
    },
  ],
  [
    "oversized key",
    (m: any) => {
      m.inputs["x".repeat(4097)] = { imports: [] };
    },
  ],
  [
    "hidden key",
    (m: any) => {
      Object.defineProperty(m.inputs, "hidden", {
        value: { imports: [] },
        enumerable: false,
      });
    },
  ],
  [
    "symbol key",
    (m: any) => {
      m.inputs[Symbol("private")] = { imports: [] };
    },
  ],
] as const)
  test("malformed metadata " + name + " is incomplete with zero counts", () => {
    const meta = metadata(nonexistingRoot, nonexistingDep);
    mutate(meta);
    noFileCalls(() =>
      assert.deepEqual(
        probeChainSummaryWorkspaceIdentity(
          nonexistingRoot,
          nonexistingDep,
          meta,
        ),
        empty,
      ),
    );
  });
test("proxies/accessors never run at any metadata reflection boundary", () => {
  let traps = 0;
  const poison = (value: object) =>
    new Proxy(value, {
      get() {
        traps++;
        throw 0;
      },
      ownKeys() {
        traps++;
        throw 0;
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw 0;
      },
      getPrototypeOf() {
        traps++;
        throw 0;
      },
    });
  const values: any[] = [poison({})];
  for (const mutate of [
    (m: any) => {
      m.inputs = poison(m.inputs);
    },
    (m: any) => {
      m.inputs[SOURCE_A] = poison(m.inputs[SOURCE_A]);
    },
    (m: any) => {
      m.inputs[SOURCE_A].imports = poison(m.inputs[SOURCE_A].imports);
    },
    (m: any) => {
      m.inputs[SOURCE_A].imports[0] = poison(m.inputs[SOURCE_A].imports[0]);
    },
    (m: any) => {
      Object.defineProperty(m, "inputs", {
        get() {
          traps++;
          throw 0;
        },
      });
    },
    (m: any) => {
      Object.defineProperty(m.inputs, SOURCE_A, {
        get() {
          traps++;
          throw 0;
        },
      });
    },
    (m: any) => {
      Object.defineProperty(m.inputs[SOURCE_A], "imports", {
        get() {
          traps++;
          throw 0;
        },
      });
    },
    (m: any) => {
      Object.defineProperty(m.inputs[SOURCE_A].imports, "0", {
        get() {
          traps++;
          throw 0;
        },
      });
    },
    (m: any) => {
      Object.defineProperty(m.inputs[SOURCE_A].imports[0], "path", {
        get() {
          traps++;
          throw 0;
        },
      });
    },
  ]) {
    const meta = metadata(nonexistingRoot, nonexistingDep);
    mutate(meta);
    values.push(meta);
  }
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  values.push(revoked.proxy);
  noFileCalls(() => {
    for (const value of values)
      assert.deepEqual(
        probeChainSummaryWorkspaceIdentity(
          nonexistingRoot,
          nonexistingDep,
          value,
        ),
        empty,
      );
  });
  assert.equal(traps, 0);
});
test("scope budgets prevent partial counts and reads", () => {
  for (const meta of [
    {
      inputs: Object.fromEntries(
        Array.from({ length: 8193 }, (_, i) => [
          `apps/${i}.ts`,
          { imports: [] },
        ]),
      ),
    },
    {
      inputs: Object.fromEntries(
        Array.from({ length: 4200 }, (_, i) => [
          String(i).padStart(4, "0") + "x".repeat(4092),
          { imports: [] },
        ]),
      ),
    },
    {
      inputs: {
        "apps/index.ts": {
          imports: Array.from({ length: 65537 }, placeholder),
        },
      },
    },
    {
      inputs: {
        "apps/index.ts": {
          imports: Array.from({ length: 4200 }, () => ({
            path: "x".repeat(4096),
            kind: "import-statement",
          })),
        },
      },
    },
  ])
    noFileCalls(() =>
      assert.deepEqual(
        probeChainSummaryWorkspaceIdentity(
          nonexistingRoot,
          nonexistingDep,
          meta,
        ),
        empty,
      ),
    );
});
for (const name of Object.keys(CHAIN_SUMMARY_WORKSPACE_PINS))
  for (const where of name.startsWith("src/")
    ? ["candidate"]
    : ["candidate", "base"]) {
    test("fixed pin refuses changed " + where + " " + name, () =>
      useFixture((f) => {
        const file = path.join(where === "candidate" ? f.root : f.base, name),
          bytes = fs.readFileSync(file);
        bytes[0] ^= 1;
        fs.writeFileSync(file, bytes);
        assert.equal(probe(f).status, "pin-refused");
      }),
    );
    test("fixed custody refuses missing " + where + " " + name, () =>
      useFixture((f) => {
        fs.unlinkSync(path.join(where === "candidate" ? f.root : f.base, name));
        assert.equal(probe(f).status, "read-refused");
      }),
    );
    test("fixed custody refuses leaf symlink " + where + " " + name, () =>
      useFixture((f) => {
        const file = path.join(where === "candidate" ? f.root : f.base, name),
          target = path.join(f.home, "public-copy");
        fs.renameSync(file, target);
        fs.symlinkSync(target, file);
        assert.equal(probe(f).status, "read-refused");
      }),
    );
  }
for (const [name, mutate, status] of [
  [
    "missing candidate dependency link",
    (f: any) => fs.unlinkSync(path.join(f.root, "node_modules")),
    "link-refused",
  ],
  [
    "candidate dependency regular directory",
    (f: any) => {
      fs.unlinkSync(path.join(f.root, "node_modules"));
      fs.mkdirSync(path.join(f.root, "node_modules"));
    },
    "link-refused",
  ],
  [
    "different dependency link spelling",
    (f: any) => {
      fs.unlinkSync(path.join(f.root, "node_modules"));
      fs.symlinkSync(
        path.relative(f.root, f.dep),
        path.join(f.root, "node_modules"),
      );
    },
    "link-refused",
  ],
  [
    "different workspace link spelling",
    (f: any) => {
      const link = path.join(f.dep, "@jsonbored/chain-summaries");
      fs.unlinkSync(link);
      fs.symlinkSync("../../packages/chain-summaries/.", link);
    },
    "link-refused",
  ],
  [
    "workspace link replaced by directory",
    (f: any) => {
      const link = path.join(f.dep, "@jsonbored/chain-summaries");
      fs.unlinkSync(link);
      fs.mkdirSync(link);
    },
    "link-refused",
  ],
  [
    "scope directory symlink",
    (f: any) => {
      const scope = path.join(f.dep, "@jsonbored"),
        target = path.join(f.dep, "@scope-copy");
      fs.renameSync(scope, target);
      fs.symlinkSync(target, scope);
    },
    "link-refused",
  ],
  [
    "candidate packages ancestor symlink",
    (f: any) => {
      const dir = path.join(f.root, "packages"),
        target = path.join(f.root, "packages-copy");
      fs.renameSync(dir, target);
      fs.symlinkSync(target, dir);
    },
    "link-refused",
  ],
  [
    "base packages ancestor symlink",
    (f: any) => {
      const dir = path.join(f.base, "packages"),
        target = path.join(f.base, "packages-copy");
      fs.renameSync(dir, target);
      fs.symlinkSync(target, dir);
    },
    "link-refused",
  ],
  [
    "candidate dist ancestor symlink",
    (f: any) => {
      const dir = path.join(f.root, "packages/chain-summaries/dist"),
        target = path.join(f.root, "packages/chain-summaries/dist-copy");
      fs.renameSync(dir, target);
      fs.symlinkSync(target, dir);
    },
    "read-refused",
  ],
  [
    "oversized file",
    (f: any) =>
      fs.writeFileSync(
        path.join(f.root, "package.json"),
        "x".repeat(1024 * 1024 + 1),
      ),
    "read-refused",
  ],
  [
    "empty file",
    (f: any) => fs.writeFileSync(path.join(f.root, "package.json"), ""),
    "read-refused",
  ],
] as const)
  test("fixed filesystem policy refuses " + name, () =>
    useFixture((f) => {
      mutate(f);
      const report = probe(f);
      assert.equal(report.status, status);
      assert.ok(
        parseChainSummaryWorkspaceMarker(chainSummaryWorkspaceMarker(report)),
      );
    }),
  );
test("opaque filesystem failure cause never runs proxy traps", () =>
  useFixture((f) => {
    let traps = 0;
    const error = new Proxy(
        {},
        {
          get() {
            traps++;
            throw 0;
          },
          ownKeys() {
            traps++;
            throw 0;
          },
          getOwnPropertyDescriptor() {
            traps++;
            throw 0;
          },
        },
      ),
      before = fs.lstatSync;
    try {
      (fs as any).lstatSync = (() => {
        throw error;
      }) as typeof fs.lstatSync;
      assert.equal(probe(f).status, "link-refused");
      assert.equal(traps, 0);
    } finally {
      (fs as any).lstatSync = before;
    }
  }));
test("root symlink is refused even if fixed public bytes are behind it", () =>
  useFixture((f) => {
    const alias = path.join(f.home, "alias");
    fs.symlinkSync(f.root, alias);
    assert.equal(
      probeChainSummaryWorkspaceIdentity(alias, f.dep, metadata(alias, f.dep))
        .status,
      "link-refused",
    );
  }));
for (const [root, dep] of [
  ["relative", nonexistingDep],
  [nonexistingRoot, "relative"],
  [nonexistingRoot, "/workspace-fixed-probe/base/not-node-modules"],
  ["/workspace-fixed-probe/base/child", nonexistingDep],
  [null, nonexistingDep],
  [
    nonexistingRoot,
    {
      toString() {
        throw 0;
      },
    },
  ],
])
  test(
    "invalid roots refuse without IO " + typeof root + "/" + typeof dep,
    () =>
      noFileCalls(() =>
        assert.deepEqual(
          probeChainSummaryWorkspaceIdentity(root, dep, {}),
          empty,
        ),
      ),
  );

test("every fixed status roundtrips its consistent public report", () => {
  const variants = [
    identified,
    empty,
    { ...empty, status: "no-match", inputScanComplete: true },
    {
      ...empty,
      status: "key-refused",
      inputScanComplete: true,
      inputCount: 2,
      escapedCount: 2,
      exactMatches: 1,
      otherEscapedCount: 1,
    },
    { ...identified, status: "edge-refused", matchedEdges: 1 },
    ...(["link-refused", "pin-refused", "read-refused"] as const).map(
      (status) => ({ ...identified, status }),
    ),
  ];
  assert.deepEqual(
    variants.map((value) => value.status).sort(),
    [...CHAIN_SUMMARY_WORKSPACE_STATUSES].sort(),
  );
  for (const value of variants) {
    const marker = chainSummaryWorkspaceMarker(value);
    assert.ok(marker.length > 0 && marker.length < 160);
    assert.deepEqual(
      parseChainSummaryWorkspaceMarker("prefix\n" + marker + "\nstack"),
      value,
    );
  }
});
const validMarker = chainSummaryWorkspaceMarker(identified);
for (const [name, value] of [
  ["null", null],
  ["extra key", { ...identified, secret: "private" }],
  ["missing key", { ...identified, matchedEdges: undefined }],
  ["wrong version", { ...identified, version: 2 }],
  ["wrong identity", { ...identified, identity: "private" }],
  ["unknown status", { ...identified, status: "private" }],
  ["negative count", { ...identified, inputCount: -1 }],
  ["fraction", { ...identified, inputCount: 3.5 }],
  ["overflow", { ...identified, inputCount: 8193 }],
  ["incomplete nonzero", { ...identified, inputScanComplete: false }],
  ["scan refusal complete", { ...identified, status: "scan-refused" }],
  [
    "identified multiple escaped",
    { ...identified, escapedCount: 2, otherEscapedCount: 1 },
  ],
  ["identified missing edge", { ...identified, matchedEdges: 1 }],
  [
    "identified no exact match",
    { ...identified, exactMatches: 0, otherEscapedCount: 1 },
  ],
  ["count mismatch", { ...identified, escapedCount: 2 }],
  ["escaped exceeds inputs", { ...identified, inputCount: 0 }],
  ["duplicate exact", { ...identified, exactMatches: 2, escapedCount: 2 }],
  ["too many edges", { ...identified, matchedEdges: 3 }],
  ["edge refusal with both matches", { ...identified, status: "edge-refused" }],
  [
    "no-match has edge",
    {
      ...identified,
      status: "no-match",
      exactMatches: 0,
      otherEscapedCount: 1,
    },
  ],
  [
    "key refusal without other",
    { ...identified, status: "key-refused", matchedEdges: 0 },
  ],
] as const)
  test("workspace marker refuses malformed report " + name, () =>
    assert.equal(chainSummaryWorkspaceMarker(value), ""),
  );
for (const [name, value] of [
  ["null", null],
  [
    "object",
    {
      toString() {
        throw 0;
      },
    },
  ],
  ["missing", "unrelated"],
  ["repeat", validMarker + validMarker],
  ["conflict", validMarker + chainSummaryWorkspaceMarker(empty)],
  ["malformed prefix", "[owner-workspace-input]" + validMarker],
  ["unknown prefix suffix", "[owner-workspace-inputX:secret]" + validMarker],
  ["truncated", validMarker.slice(0, -1)],
  ["overflow", validMarker.replace(":3:", ":8193:")],
  ["leading zero", validMarker.replace(":3:", ":03:")],
  ["fraction", validMarker.replace(":3:", ":3.0:")],
  ["exponent", validMarker.replace(":3:", ":3e0:")],
  ["negative", validMarker.replace(":3:", ":-3:")],
  [
    "unknown status",
    validMarker.replace(":identified:", ":https://private/secret:"),
  ],
  ["extra field", validMarker.replace("]", ":0]")],
  [
    "edge refusal with both matches",
    validMarker.replace(":identified:", ":edge-refused:"),
  ],
  ["oversized", validMarker + "x".repeat(65536)],
] as const)
  test("workspace parser refuses " + name, () =>
    assert.equal(parseChainSummaryWorkspaceMarker(value), null),
  );
test("report marker/parser do not reflect on proxy/accessor or stringify arbitrary input", () => {
  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        traps++;
        throw 0;
      },
      ownKeys() {
        traps++;
        throw 0;
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw 0;
      },
      getPrototypeOf() {
        traps++;
        throw 0;
      },
    },
  );
  assert.equal(chainSummaryWorkspaceMarker(proxy), "");
  assert.equal(parseChainSummaryWorkspaceMarker(proxy), null);
  const value = { ...identified };
  Object.defineProperty(value, "status", {
    get() {
      traps++;
      throw 0;
    },
  });
  assert.equal(chainSummaryWorkspaceMarker(value), "");
  assert.equal(traps, 0);
});
test("fixed file opens always use nonblocking and no-follow flags", () =>
  useFixture((f) => {
    const before = fs.openSync;
    let calls = 0;
    try {
      (fs as any).openSync = (file: any, flags: any, ...rest: any[]) => {
        calls++;
        assert.equal(typeof flags, "number");
        assert.ok((flags & fs.constants.O_NONBLOCK) !== 0);
        assert.ok((flags & fs.constants.O_NOFOLLOW) !== 0);
        return (before as any)(file, flags, ...rest);
      };
      assert.equal(probe(f).status, "identified");
      assert.equal(calls, 10);
    } finally {
      (fs as any).openSync = before;
    }
  }));
test("exact input/import scan budgets remain complete without fixed file reads", () => {
  const cap = CHAIN_SUMMARY_WORKSPACE_LIMITS;
  const records = {
    inputs: Object.fromEntries(
      Array.from({ length: cap.inputs }, (_, i) => [
        `apps/${i}.ts`,
        { imports: [] },
      ]),
    ),
  };
  const imports = {
    inputs: {
      "apps/a.ts": {
        imports: Array.from({ length: cap.imports }, placeholder),
      },
    },
  };
  noFileCalls(() => {
    assert.equal(
      probeChainSummaryWorkspaceIdentity(
        nonexistingRoot,
        nonexistingDep,
        records,
      ).inputCount,
      cap.inputs,
    );
    assert.equal(
      probeChainSummaryWorkspaceIdentity(
        nonexistingRoot,
        nonexistingDep,
        imports,
      ).status,
      "no-match",
    );
  });
});
test("duplicate canonical dependency aliases refuse before fixed reads", () => {
  const meta = metadata(nonexistingRoot, nonexistingDep);
  meta.inputs["node_modules/example/index.js"] = { imports: [] };
  meta.inputs["../base/node_modules/example/index.js"] = { imports: [] };
  noFileCalls(() =>
    assert.deepEqual(
      probeChainSummaryWorkspaceIdentity(nonexistingRoot, nonexistingDep, meta),
      empty,
    ),
  );
});
test("early EOF or a changed opened-file identity becomes a fixed read refusal", () => {
  for (const field of ["readSync", "fstatSync"] as const)
    useFixture((f) => {
      const before = fs[field];
      try {
        (fs as any)[field] =
          field === "readSync"
            ? () => 0
            : (...args: any[]) => ({
                ...(before as any)(...args),
                isFile: () => false,
              });
        assert.equal(probe(f).status, "read-refused");
      } finally {
        (fs as any)[field] = before;
      }
    });
});

test("public report cannot claim two distinct edges with fewer than three input records", () => {
  for (const inputCount of [1, 2])
    assert.equal(
      chainSummaryWorkspaceMarker({ ...identified, inputCount }),
      "",
    );
});
test("a late file exceeding its pin is refused before opening or reading beyond the total budget", () =>
  useFixture((f) => {
    const late = path.join(f.root, SOURCE_B);
    fs.writeFileSync(
      late,
      "x".repeat(CHAIN_SUMMARY_WORKSPACE_LIMITS.fileBytes),
    );
    const originalOpen = fs.openSync,
      originalRead = fs.readSync;
    let openedLate = false,
      bytesRead = 0;
    try {
      (fs as any).openSync = (file: any, ...args: any[]) => {
        if (file === late) openedLate = true;
        return (originalOpen as any)(file, ...args);
      };
      (fs as any).readSync = (...args: any[]) => {
        const count = (originalRead as any)(...args);
        bytesRead += count;
        assert.ok(bytesRead <= CHAIN_SUMMARY_WORKSPACE_LIMITS.allFileBytes);
        return count;
      };
      assert.equal(probe(f).status, "read-refused");
      assert.equal(openedLate, false);
      assert.equal(
        bytesRead,
        Object.entries(CHAIN_SUMMARY_WORKSPACE_PINS).reduce(
          (sum, [name, pin]) =>
            sum +
            (name === SOURCE_B
              ? 0
              : pin.bytes * (name.startsWith("src/") ? 1 : 2)),
          0,
        ),
      );
    } finally {
      (fs as any).openSync = originalOpen;
      (fs as any).readSync = originalRead;
    }
  }));
