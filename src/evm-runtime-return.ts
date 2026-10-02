import type { RuntimeEvmOutput } from "./evm-runtime-outputs.ts";
import type { NativeValue } from "./native-runtime-values.ts";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const arrayType = (type: string) => /^(.*)\[(\d*)\]$/.exec(type);
const record = (value: unknown): value is { [key: string]: NativeValue } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Decode the selected official output ABI in canonical layout order. Dynamic
 * tails must start exactly after the preceding head/tail; aliasing, gaps and
 * trailing bytes are rejected. Raw EVM result bytes remain in the native value. */
function decodeOutputs(outputs: RuntimeEvmOutput[], input: string): NativeValue[] {
  if (input.length > 524290 || !/^0x(?:[0-9a-fA-F]{2})*$/.test(input))
    throw new Error("Invalid or oversized EVM return data");
  const hex = input.slice(2).toLowerCase(), size = hex.length / 2;
  let work = 0;
  function word(offset: number) {
    if (offset + 32 > size) throw new Error("Truncated EVM return word");
    return hex.slice(offset * 2, (offset + 32) * 2);
  }
  function length(offset: number) {
    const integer = BigInt(`0x${word(offset)}`);
    if (integer > BigInt(size)) throw new Error("EVM return length exceeds byte budget");
    return Number(integer);
  }
  function dynamic(param: RuntimeEvmOutput): boolean {
    const array = arrayType(param.type);
    if (array) return !array[2] || dynamic({ ...param, type: array[1] });
    return param.type === "bytes" || param.type === "string" ||
      (param.type === "tuple" && param.components!.some(dynamic));
  }
  function headBytes(param: RuntimeEvmOutput): number {
    if (dynamic(param)) return 32;
    const array = arrayType(param.type);
    if (array) return Number(array[2]) * headBytes({ ...param, type: array[1] });
    if (param.type === "tuple") return param.components!.reduce((total, row) => total + headBytes(row), 0);
    return 32;
  }
  function tuple(params: RuntimeEvmOutput[], start: number, depth: number, repeat?: number): {values: NativeValue[];end:number} {
    const shapes = params.map(param => ({ param, dynamic: dynamic(param), bytes: headBytes(param) }));
    const count = repeat ?? params.length;
    const headSize = repeat === undefined ? shapes.reduce((total,row)=>total+row.bytes,0) : repeat * shapes[0].bytes;
    if (start + headSize > size) throw new Error("Truncated EVM return head");
    let head = start, end = start + headSize;
    const values: NativeValue[] = [];
    for (let index = 0; index < count; index++) {
      const shape = shapes[repeat === undefined ? index : 0], param = shape.param;
      const isDynamic = shape.dynamic;
      const offset = isDynamic ? start + length(head) : head;
      if (isDynamic && offset !== end) throw new Error("Noncanonical EVM return offset");
      const item = decode(param,offset,depth+1);
      values.push(item.value);
      if (isDynamic) end = item.end;
      head += shape.bytes;
    }
    return {values,end};
  }
  function decode(param: RuntimeEvmOutput, offset: number, depth: number): {value:NativeValue;end:number} {
    if (depth > 64 || ++work > 16384) throw new Error("EVM return exceeds work budget");
    const array = arrayType(param.type);
    if (array) {
      const count = array[2] ? Number(array[2]) : length(offset);
      if (count > 16384 - work) throw new Error("EVM return exceeds work budget");
      const item = { ...param, type: array[1] }, start = offset + (array[2] ? 0 : 32);
      if (start + count * headBytes(item) > size) throw new Error("Truncated EVM return array");
      const result = tuple([item],start,depth,count);
      return {value:result.values,end:result.end};
    }
    if (param.type === "tuple") {
      const rows=param.components!, result=tuple(rows,offset,depth);
      const named=rows.every(row=>row.name) && new Set(rows.map(row=>row.name)).size===rows.length;
      return {value:named ? Object.fromEntries(rows.map((row,index)=>[row.name,result.values[index]])):result.values,end:result.end};
    }
    if (param.type === "bytes" || param.type === "string") {
      const count=length(offset), start=offset+32, end=start+Math.ceil(count/32)*32;
      if (end > size || !/^0*$/.test(hex.slice((start+count)*2,end*2))) throw new Error("Invalid EVM return byte padding");
      const bytes=hex.slice(start*2,(start+count)*2);
      return {value:param.type==="bytes" ? `0x${bytes}` : utf8.decode(Buffer.from(bytes,"hex")),end};
    }
    const value=word(offset), end=offset+32;
    if (param.type === "address") {
      if (!/^0{24}/.test(value)) throw new Error("Invalid EVM return address padding");
      return {value:`0x${value.slice(24)}`,end};
    }
    if (param.type === "bool") {
      if (!/^0{63}[01]$/.test(value)) throw new Error("Invalid EVM return bool");
      return {value:value.endsWith("1"),end};
    }
    const fixed=/^bytes(\d+)$/.exec(param.type);
    if (fixed) {
      const bytes=Number(fixed[1])*2;
      if (!/^0*$/.test(value.slice(bytes))) throw new Error("Invalid EVM return fixed-byte padding");
      return {value:`0x${value.slice(0,bytes)}`,end};
    }
    const bits=Number(param.type.slice(4)), integer=BigInt(`0x${value}`);
    if (integer >= 1n << BigInt(bits)) throw new Error("EVM return integer exceeds width");
    return {value:bits <= 32 ? Number(integer) : integer.toString(),end};
  }
  const result=tuple(outputs,0,0);
  if (result.end!==size) throw new Error("Trailing EVM return data");
  return result.values;
}

/** Interpret only successful call results. Dispatch errors, reverts and EVM
 * execution errors keep their exact native shape without ABI interpretation. */
export function decodeNativeEvmResult(value: NativeValue, outputs: RuntimeEvmOutput[]) {
  if (!record(value)) return {status:"unrecognized_result" as const};
  if (value.variant === "Err") return {status:"dispatch_error" as const};
  if (value.variant !== "Ok" || !record(value.fields)) return {status:"unrecognized_result" as const};
  const reason=value.fields.exit_reason;
  if (!record(reason)) return {status:"unrecognized_result" as const};
  if (reason.variant === "Revert") return {status:"reverted" as const};
  if (reason.variant === "Error" || reason.variant === "Fatal") return {status:"execution_error" as const};
  if (reason.variant !== "Succeed" || typeof value.fields.value !== "string") return {status:"unrecognized_result" as const};
  try {return {status:"decoded" as const, values:decodeOutputs(outputs,value.fields.value)};}
  catch {return {status:"invalid_output" as const};}
}
