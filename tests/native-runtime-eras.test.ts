import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { TypeRegistry } from "@polkadot/types/create";
import { Metadata } from "@polkadot/types/metadata";
import eras from "./fixtures/native-runtime-eras-compiled.ts";
import {
  sampleNativeValue,
  UninhabitedType,
} from "./fixtures/native-compiled-values.ts";
import {
  decodeNativeMetadata,
  unwrapNativeMetadata,
  type NativeField,
} from "../src/native-runtime-metadata.ts";
import {
  decodeNativeValue,
  encodeNativeValue,
  nativeHex,
  type NativeValue,
} from "../src/native-runtime-values.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import { encodeRuntimeEvmCall } from "../src/evm-runtime-abi.ts";
import { evmRuntimeCatalogue } from "../src/evm-runtime-catalogue.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";

const hash = `0x${"33".repeat(32)}`;
const specs = [
  430, 431, 432, 437, 438, 439, 440, 441, 442, 443, 445, 446, 447, 448, 450,
  452, 453, 454, 459, 464, 466, 467, 468, 469, 470,
];
assert.deepEqual(
  eras.map((era) => era.spec),
  specs,
);

for (const era of eras) {
  const bare15 = unwrapNativeMetadata(era.v15)!;
  const model15 = decodeNativeMetadata(bare15);
  const registry15 = new TypeRegistry();
  registry15.setMetadata(
    new Metadata(registry15, Buffer.from(bare15.slice(2), "hex")),
  );
  const sample = (id: number) => sampleNativeValue(model15, id);

  // Source identity and execution results are deliberately synthetic. The ABI
  // and RuntimeVersion are extracted from checksum-verified release WASM.
  function fixture(metadataVersion: 14 | 15, result?: NativeValue) {
    const calls: { method: string; params: unknown[] }[] = [];
    const rpc: BasketRpc = async (method, params) => {
      if (method === "chain_getFinalizedHead") return hash;
      if (method === "chain_getHeader") return { number: "0x1f4" };
      if (method === "chain_getBlockHash") return `0x${"44".repeat(32)}`;
      if (method === "state_getRuntimeVersion") return era.runtimeVersion;
      if (method === "state_getStorageHash")
        return `0x${(era.spec * 100 + metadataVersion).toString(16).padStart(64, "0")}`;
      if (method === "state_getMetadata") return unwrapNativeMetadata(era.v14);
      assert.equal(method, "state_call");
      if (params[0] === "Metadata_metadata_at_version")
        return metadataVersion === 15 ? era.v15 : "0x00";
      calls.push({ method, params });
      const api = model15.apis.find((row) =>
        String(params[0]).startsWith(`${row.name}_`),
      )!;
      const member = api.methods.find(
        (row) => `${api.name}_${row.name}` === params[0],
      )!;
      return nativeHex(
        encodeNativeValue(
          model15,
          member.output,
          result ?? sample(member.output),
        ),
      );
    };
    rpc.batch = (rows) =>
      Promise.all(rows.map((row) => rpc(row.method, row.params)));
    return { rpc, calls };
  }

  test(`compiled v${era.spec} V14/V15 constants and every inhabitable pallet call match the independent registry`, async () => {
    let prepared = 0;
    let constants = 0;
    const voidCalls: string[] = [];
    for (const metadataVersion of [14, 15] as const) {
      const wrapped = era[`v${metadataVersion}`];
      assert.equal(
        createHash("sha256")
          .update(Buffer.from(wrapped.slice(2), "hex"))
          .digest("hex"),
        era[`v${metadataVersion}_sha256`],
      );
      const bare = unwrapNativeMetadata(wrapped)!;
      const model = decodeNativeMetadata(bare);
      const registry = new TypeRegistry();
      const reference = new Metadata(
        registry,
        Buffer.from(bare.slice(2), "hex"),
      );
      registry.setMetadata(reference);
      const view = metadataVersion === 14 ? reference.asV14 : reference.asV15;
      assert.equal(model.version, metadataVersion);
      assert.deepEqual(
        [...model.types.values()].map((row) => [row.id, row.path]),
        view.lookup.types.map((row) => [
          row.id.toNumber(),
          row.type.path.map(String),
        ]),
      );
      assert.deepEqual(
        model.pallets.map((row) => [row.name, row.index]),
        view.pallets.map((row) => [row.name.toString(), row.index.toNumber()]),
      );
      const f = fixture(metadataVersion);
      for (const pallet of model.pallets) {
        for (const constant of pallet.constants) {
          const bytes = encodeNativeValue(
            model,
            constant.type,
            decodeNativeValue(model, constant.type, constant.value),
          );
          assert.equal(nativeHex(bytes), constant.value);
          const referenceValue = registry.createTypeUnsafe(
            `Lookup${constant.type}`,
            [bytes],
          );
          assert.equal(referenceValue.encodedLength, bytes.length);
          assert.equal(nativeHex(referenceValue.toU8a()), constant.value);
          constants++;
        }
        if (pallet.calls === null) continue;
        const type = model.types.get(pallet.calls)!.definition;
        assert.equal(type.kind, "variant");
        if (type.kind !== "variant") continue;
        for (const call of type.variants) {
          let args: NativeValue[];
          try {
            args = call.fields.map((field) =>
              sampleNativeValue(model, field.type),
            );
          } catch (error) {
            if (!(error instanceof UninhabitedType)) throw error;
            assert.equal(pallet.name, "Grandpa");
            assert.match(call.name, /^report_equivocation/);
            assert.throws(
              () =>
                encodeNativeValue(model, error.id, {
                  variant: "Void",
                  fields: {},
                }),
              /Invalid native enum variant/,
            );
            voidCalls.push(`${metadataVersion}:${pallet.name}.${call.name}`);
            continue;
          }
          const response = await queryNativeRuntime(
            {
              as_of: hash,
              operations: [
                {
                  kind: "prepare",
                  pallet: pallet.name,
                  member: call.name,
                  args,
                },
              ],
            },
            f.rpc,
          );
          assert.equal(response.source.runtime_spec_version, era.spec);
          assert.equal(response.source.metadata_version, metadataVersion);
          const data = response.results[0]!.call_data!;
          const independent = registry.createType(
            "Call",
            Buffer.from(data.slice(2), "hex"),
          );
          assert.deepEqual(
            [...independent.callIndex],
            [pallet.index, call.index],
            `${pallet.name}.${call.name}`,
          );
          assert.equal(nativeHex(independent.toU8a()), data);
          assert.equal(independent.encodedLength, (data.length - 2) / 2);
          prepared++;
        }
      }
      assert.equal(f.calls.length, 0);
    }
    assert.ok(prepared > 0);
    assert.ok(constants > 0);
    console.log(
      "NATIVE_COMPILED_ERA_CALLS",
      JSON.stringify({
        spec: era.spec,
        prepared,
        constants,
        voidCalls,
        execution_rpcs: 0,
        fixture: true,
        production: false,
      }),
    );
  }, 60000);

  test(`compiled v${era.spec} runtime API simulations and V14 byte reads preserve the release-specific ABI`, async () => {
    let simulations = 0;
    for (const [apiName, memberName] of [
      ["EthereumRuntimeRPCApi", "call"],
      ["EthereumRuntimeRPCApi", "create"],
      ["ContractsApi", "call"],
      ["ContractsApi", "instantiate"],
      ["ContractsApi", "upload_code"],
    ]) {
      const api = model15.apis.find((row) => row.name === apiName)!;
      const member = api.methods.find((row) => row.name === memberName)!;
      const args = member.inputs.map((field) => sample(field.type));
      member.inputs.forEach((field, index) => {
        if (field.name === "gas_limit")
          args[index] =
            apiName === "ContractsApi"
              ? {
                  variant: "Some",
                  fields: { ref_time: "100000000000", proof_size: "32768" },
                }
              : ["500000", "0", "0", "0"];
      });
      const f = fixture(15);
      const response = await queryNativeRuntime(
        {
          operations: [
            { kind: "runtime", api: apiName, member: memberName, args },
          ],
        },
        f.rpc,
      );
      const pieces = member.inputs.map((field, index) => {
        const bytes = encodeNativeValue(model15, field.type, args[index]!);
        const independent = registry15.createTypeUnsafe(`Lookup${field.type}`, [
          bytes,
        ]);
        assert.equal(independent.encodedLength, bytes.length);
        assert.equal(nativeHex(independent.toU8a()), nativeHex(bytes));
        return bytes;
      });
      assert.deepEqual(f.calls, [
        {
          method: "state_call",
          params: [
            `${apiName}_${memberName}`,
            nativeHex(Buffer.concat(pieces)),
            hash,
          ],
        },
      ]);
      const output = encodeNativeValue(
        model15,
        member.output,
        response.results[0]!.value!,
      );
      const independent = registry15.createTypeUnsafe(
        `Lookup${member.output}`,
        [output],
      );
      assert.equal(independent.encodedLength, output.length);
      assert.equal(nativeHex(independent.toU8a()), nativeHex(output));
      simulations++;
    }
    const nonce = model15.apis
      .find((row) => row.name === "AccountNonceApi")!
      .methods.find((row) => row.name === "account_nonce")!;
    const input = nativeHex(
      encodeNativeValue(
        model15,
        nonce.inputs[0]!.type,
        sample(nonce.inputs[0]!.type),
      ),
    );
    const f = fixture(14);
    const response = await queryNativeRuntime(
      {
        operations: [
          {
            kind: "runtime_scale",
            api: "AccountNonceApi",
            member: "account_nonce",
            input,
          },
        ],
      },
      f.rpc,
    );
    assert.equal(response.source.metadata_version, 14);
    assert.equal(
      response.results[0]!.value,
      nativeHex(encodeNativeValue(model15, nonce.output, sample(nonce.output))),
    );
    assert.equal(f.calls.length, 1);
    console.log(
      "NATIVE_COMPILED_ERA_APIS",
      JSON.stringify({
        spec: era.spec,
        simulations,
        v14_reads: 1,
        fixture: true,
        production: false,
      }),
    );
  });

  test(`compiled v${era.spec} precompile ABI binds byte-exact runtime simulations and V14/V15 wallet preparation`, async () => {
    const to = `0x${(2053).toString(16).padStart(40, "0")}`;
    const evm_call = {
      signature: "getStake(bytes32,bytes32,uint256)",
      args: [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, "19"],
    };
    const encoded = encodeRuntimeEvmCall(
      era.spec,
      to,
      evm_call.signature,
      evm_call.args,
    );
    for (const format of [14, 15] as const) {
      const model = decodeNativeMetadata(
        unwrapNativeMetadata(era[`v${format}`])!,
      );
      const registry = new TypeRegistry();
      registry.setMetadata(
        new Metadata(
          registry,
          Buffer.from(unwrapNativeMetadata(era[`v${format}`])!.slice(2), "hex"),
        ),
      );
      const pallet = model.pallets.find((row) => row.name === "EVM")!;
      const calls = model.types.get(pallet.calls!)!.definition;
      assert.equal(calls.kind, "variant");
      if (calls.kind !== "variant") return;
      const call: { name: string; index: number; fields: NativeField[] } =
        calls.variants.find((row) => row.name === "call")!;
      const args = call.fields.map((field) =>
        field.name === "target"
          ? to
          : field.name === "input"
            ? "0x"
            : sampleNativeValue(model, field.type),
      );
      const inputIndex = call.fields.findIndex(
        (field) => field.name === "input",
      );
      const expected = Buffer.concat([
        Buffer.from([pallet.index, call.index]),
        ...call.fields.map((field, index) =>
          registry
            .createTypeUnsafe(`Lookup${field.type}`, [
              encodeNativeValue(
                model,
                field.type,
                index === inputIndex ? encoded.input : args[index]!,
              ),
            ])
            .toU8a(),
        ),
      ]);
      const f = fixture(format);
      const response = await queryNativeRuntime(
        {
          operations: [
            { kind: "prepare", pallet: "EVM", member: "call", args, evm_call },
          ],
        },
        f.rpc,
      );
      assert.equal(response.results[0]!.call_data, nativeHex(expected));
      assert.equal(Object.hasOwn(response.results[0]!, "evm_result"), false);
      assert.equal(f.calls.length, 0);
      assert.equal(
        (
          response.results[0]!.contract as {
            evm_call: { source_commit: string };
          }
        ).evm_call.source_commit,
        era.commit,
      );
      const discovery = await queryNativeRuntime(
        { operations: [{ kind: "describe", evm: to, offset: 0, limit: 64 }] },
        f.rpc,
      );
      assert.equal(discovery.types.length, 0);
      assert.equal(
        (discovery.results[0]!.contract as { source_commit: string })
          .source_commit,
        era.commit,
      );
      assert.equal(f.calls.length, 0);
    }
    const api = model15.apis.find(
      (row) => row.name === "EthereumRuntimeRPCApi",
    )!;
    const method = api.methods.find((row) => row.name === "call")!;
    const args = method.inputs.map((field) =>
      field.name === "to"
        ? to
        : field.name === "data"
          ? "0x"
          : field.name === "gas_limit"
            ? ["500000", "0", "0", "0"]
            : sample(field.type),
    );
    const operation = {
      kind: "runtime",
      api: api.name,
      member: method.name,
      args,
      evm_call,
    };
    const returned = sample(method.output) as {
      variant: string;
      fields: {
        exit_reason: NativeValue;
        value: string;
        [key: string]: NativeValue;
      };
    };
    returned.fields.exit_reason = {
      variant: "Succeed",
      fields: { variant: "Returned", fields: {} },
    };
    returned.fields.value = `0x${(1n << 200n).toString(16).padStart(64, "0")}`;
    const f = fixture(15, returned);
    const response = await queryNativeRuntime(
      { operations: [operation, operation] },
      f.rpc,
    );
    assert.equal(f.calls.length, 1);
    const expected = Buffer.concat(
      method.inputs.map((field, index) =>
        registry15
          .createTypeUnsafe(`Lookup${field.type}`, [
            encodeNativeValue(
              model15,
              field.type,
              field.name === "data" ? encoded.input : args[index]!,
            ),
          ])
          .toU8a(),
      ),
    );
    assert.equal(f.calls[0]!.params[1], nativeHex(expected));
    assert.deepEqual(response.results[0], response.results[1]);
    assert.deepEqual(response.results[0]!.value, returned);
    assert.deepEqual(response.results[0]!.evm_result, {
      status: "decoded",
      values: [(1n << 200n).toString()],
    });
    const before = f.calls.length;
    await assert.rejects(
      () =>
        queryNativeRuntime(
          {
            operations: [
              {
                ...operation,
                args: args.map((value, index) =>
                  method.inputs[index]!.name === "gas_limit"
                    ? ["1000001", "0", "0", "0"]
                    : value,
                ),
              },
            ],
          },
          f.rpc,
        ),
      /gas budget/,
    );
    await assert.rejects(
      () =>
        queryNativeRuntime(
          { operations: [{ kind: "describe", evm: true, pallet: "EVM" }] },
          f.rpc,
        ),
      /Describe one/,
    );
    assert.equal(f.calls.length, before);
    assert.equal(
      encoded.source_commit,
      evmRuntimeCatalogue.releases.find((row) => row[0] === era.spec)![1],
    );
  });

  test(`compiled v${era.spec} full EVM deployment artifacts preserve creation and unsigned native bytes in both formats`, async () => {
    const data = Buffer.alloc(49152, 0xa5), hex = nativeHex(data);
    const code_artifact = { url: `https://raw.githubusercontent.com/example/contracts/${"a".repeat(40)}/init.bin`, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    for (const [format, kind, memberName] of [[15,"runtime","create"],[14,"prepare","create"],[15,"prepare","create"],[14,"prepare","create2"],[15,"prepare","create2"]] as const) {
      const bare = unwrapNativeMetadata(era[`v${format}`])!;
      const model = format === 15 ? model15 : decodeNativeMetadata(bare);
      const reference = new TypeRegistry(); reference.setMetadata(new Metadata(reference,Buffer.from(bare.slice(2),"hex")));
      const pallet = model.pallets.find(row=>row.name==="EVM")!;
      const calls = model.types.get(pallet.calls!)!.definition;
      assert.equal(calls.kind,"variant"); if(calls.kind!=="variant")continue;
      const variant = calls.variants.find(row=>row.name===memberName)!;
      const method = model15.apis.find(row=>row.name==="EthereumRuntimeRPCApi")!.methods.find(row=>row.name==="create")!;
      const fields = kind === "runtime" ? method.inputs : variant.fields, codeName = kind === "runtime" ? "data":"init";
      const args = fields.map(field=>field.name===codeName ? "0x" : field.name==="gas_limit" && kind==="runtime" ? ["500000","0","0","0"] : sampleNativeValue(model,field.type));
      const operation = {kind,...(kind==="runtime" ? {api:"EthereumRuntimeRPCApi"}:{pallet:"EVM"}),member:memberName,args,code_artifact};
      const f=fixture(format);let fetches=0;
      const fetchImpl=(async (url,options)=>{fetches++;assert.equal(url,code_artifact.url);assert.equal(options!.redirect,"manual");return new Response(data);}) as typeof fetch;
      const request={operations:[operation,operation]};
      const result=await queryNativeRuntime(request,f.rpc,fetchImpl);
      assert.equal(fetches,1);assert.equal(f.calls.length,kind==="runtime" ? 1:0);
      assert.deepEqual(result.results[0],result.results[1]);
      assert.deepEqual((result.results[0]!.contract as {code_artifact:unknown}).code_artifact,code_artifact);
      assert.equal(Object.hasOwn(result.results[0]!,"evm_result"),false);
      const pieces=fields.map((field,index)=>reference.createTypeUnsafe(`Lookup${field.type}`,[encodeNativeValue(model,field.type,field.name===codeName ? hex:args[index]!)]).toU8a());
      if(kind==="runtime")assert.deepEqual(f.calls[0]!.params,["EthereumRuntimeRPCApi_create",nativeHex(Buffer.concat(pieces)),hash]);
      else assert.equal(result.results[0]!.call_data,nativeHex(Buffer.concat([Buffer.from([pallet.index,variant.index]),...pieces])));
      assert.equal(args[fields.findIndex(row=>row.name===codeName)],"0x");
      await assert.rejects(()=>queryNativeRuntime({operations:[{...operation,code_artifact:undefined,args:fields.map((field,index)=>field.name===codeName ? hex:args[index]!)}]},f.rpc,fetchImpl),/Native request exceeds byte budget/);
      if(kind==="runtime")for(const gas of [["0","0","0","0"],["1000001","0","0","0"],["1","1","0","0"]]) {
        await assert.rejects(()=>queryNativeRuntime({operations:[{...operation,args:fields.map((field,index)=>field.name==="gas_limit" ? gas:args[index]!)}]},f.rpc,fetchImpl),/gas budget/);
        assert.equal(fetches,1);assert.equal(f.calls.length,1);
      }
      console.log("NATIVE_EVM_CODE_ARTIFACT_FIXTURE",JSON.stringify({spec:era.spec,format,kind,member:memberName,code_bytes:data.length,compact_single_request_bytes:Buffer.byteLength(JSON.stringify({operations:[operation]})),embedded_code_hex_bytes:data.length*2,artifact_fetches:fetches,execution_requests:f.calls.length,exact_bytes:true,fixture:true,production:false}));
    }
  });
}
