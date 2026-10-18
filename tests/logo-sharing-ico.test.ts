import assert from "node:assert/strict";
import sharp from "sharp";
import { test } from "vitest";

import { icoPngFrame } from "../scripts/logo-sharing-ico.ts";

interface Frame {
  bytes: Uint8Array;
  width: number;
  height: number;
}

async function png(width = 2, height = 2): Promise<Uint8Array> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 12, g: 34, b: 56, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
}

function icon(frames: Frame[], padding = 0): Uint8Array {
  const directoryEnd = 6 + frames.length * 16;
  const size = frames.reduce((sum, frame) => sum + frame.bytes.byteLength, 0);
  const source = new Uint8Array(directoryEnd + size + padding);
  const view = new DataView(source.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, frames.length, true);
  let offset = directoryEnd;
  for (const [index, frame] of frames.entries()) {
    const entry = 6 + index * 16;
    source[entry] = frame.width === 256 ? 0 : frame.width;
    source[entry + 1] = frame.height === 256 ? 0 : frame.height;
    view.setUint16(entry + 4, 1, true);
    view.setUint16(entry + 6, 32, true);
    view.setUint32(entry + 8, frame.bytes.byteLength, true);
    view.setUint32(entry + 12, offset, true);
    source.set(frame.bytes, offset);
    offset += frame.bytes.byteLength;
  }
  return source;
}

function dib(width = 2, height = 2): Uint8Array {
  const xorBytes = width * height * 4;
  const maskBytes = Math.ceil(width / 32) * 4 * height;
  const bytes = new Uint8Array(40 + xorBytes + maskBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 40, true);
  view.setInt32(4, width, true);
  view.setInt32(8, height * 2, true);
  view.setUint16(12, 1, true);
  view.setUint16(14, 32, true);
  view.setUint32(20, xorBytes + maskBytes, true);
  return bytes;
}

function refuses(source: Uint8Array) {
  const expected = /Invalid or unsupported sharing ICO/;
  assert.throws(() => icoPngFrame(source), expected);
}

test("PNG-backed ICOs preserve exact frame bytes for the native decoder", async () => {
  const bytes = await png();
  const source = icon([{ bytes, width: 2, height: 2 }]);
  const before = new Uint8Array(source);
  const selected = icoPngFrame(source);
  assert.deepEqual(selected, new Uint8Array(bytes));
  assert.deepEqual(source, before);
  const metadata = await sharp(selected).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 2);
  selected[0] = 0;
  assert.deepEqual(source, before, "the returned frame has independent bytes");
});

test("the largest PNG area wins in either order without decoding DIB alternatives", async () => {
  const small = { bytes: await png(1, 8), width: 1, height: 8 };
  const large = { bytes: await png(4, 3), width: 4, height: 3 };
  const unsupported = { bytes: dib(16, 16), width: 16, height: 16 };
  for (const frames of [
    [small, unsupported, large],
    [large, small, unsupported],
  ]) {
    assert.deepEqual(icoPngFrame(icon(frames)), new Uint8Array(large.bytes));
  }
  const tie = { bytes: await png(3, 4), width: 3, height: 4 };
  const selected = icoPngFrame(icon([large, tie]));
  assert.deepEqual(selected, new Uint8Array(large.bytes));
});

test("zero dimensions encode 256 pixels and sliced input keeps its byte offset", async () => {
  const bytes = await png(256, 256);
  const source = icon([{ bytes, width: 256, height: 256 }]);
  assert.equal(source[6], 0);
  assert.equal(source[7], 0);
  const container = new Uint8Array(source.byteLength + 12);
  container.set(source, 7);
  const view = container.subarray(7, 7 + source.byteLength);
  assert.deepEqual(icoPngFrame(view), new Uint8Array(bytes));
});

test("source and directory limits include their exact ceilings", async () => {
  const frame = { bytes: await png(), width: 2, height: 2 };
  const ordinary = icon([frame]);
  const maximum = icon([frame], 524288 - ordinary.byteLength);
  assert.deepEqual(icoPngFrame(maximum), new Uint8Array(frame.bytes));
  refuses(new Uint8Array(524289));
  for (let length = 0; length < 6; length++) refuses(new Uint8Array(length));
  const many = Array.from({ length: 256 }, () => frame);
  assert.deepEqual(icoPngFrame(icon(many)), new Uint8Array(frame.bytes));
  refuses(icon([...many, frame]));
});

test("malformed ICONDIR records cannot hide behind a valid PNG frame", async () => {
  const bytes = await png();
  const original = icon([{ bytes, width: 2, height: 2 }]);
  const mutations: ((source: Uint8Array, view: DataView) => void)[] = [
    (_source, view) => view.setUint16(0, 1, true),
    (_source, view) => view.setUint16(2, 2, true),
    (_source, view) => view.setUint16(4, 0, true),
    (_source, view) => view.setUint16(4, 256, true),
    (source) => {
      source[9] = 1;
    },
    (_source, view) => view.setUint32(14, 0, true),
    (_source, view) => view.setUint32(18, 21, true),
    (_source, view) => view.setUint32(18, 0xffffffff, true),
    (_source, view) => view.setUint32(14, 0xffffffff, true),
    (_source, view) => view.setUint32(14, bytes.byteLength + 1, true),
  ];
  for (const mutate of mutations) {
    const source = new Uint8Array(original);
    mutate(source, new DataView(source.buffer));
    refuses(source);
  }
  refuses(original.subarray(0, 6));
  const two = icon([
    { bytes, width: 2, height: 2 },
    { bytes, width: 2, height: 2 },
  ]);
  new DataView(two.buffer).setUint32(34, 0xffffffff, true);
  refuses(two);
});

test("every PNG header must match its bounded descriptor before selection", async () => {
  const bytes = await png();
  const mutations: ((source: Uint8Array, view: DataView) => void)[] = [
    (source) => {
      source[0] = 0;
    },
    (_source, view) => view.setUint32(8, 12),
    (_source, view) => view.setUint32(12, 0x49444154),
    (_source, view) => view.setUint32(16, 0),
    (_source, view) => view.setUint32(16, 3),
    (_source, view) => view.setUint32(20, 257),
  ];
  for (const mutate of mutations) {
    const changed = new Uint8Array(bytes);
    mutate(changed, new DataView(changed.buffer));
    const frames = [
      { bytes, width: 2, height: 2 },
      { bytes: changed, width: 2, height: 2 },
    ];
    refuses(icon(frames));
    refuses(icon(frames.toReversed()));
  }
  const truncated = new Uint8Array(bytes.subarray(0, 32));
  refuses(icon([{ bytes: truncated, width: 2, height: 2 }]));
});

test("DIB-only, unknown and malformed unsupported alternatives are refused", async () => {
  const unsupported = { bytes: dib(), width: 2, height: 2 };
  refuses(icon([unsupported]));
  refuses(icon([{ bytes: new Uint8Array(40), width: 2, height: 2 }]));
  const bytes = await png();
  const mutations: ((view: DataView) => void)[] = [
    (view) => view.setUint32(0, 124, true),
    (view) => view.setInt32(4, 3, true),
    (view) => view.setInt32(8, 3, true),
    (view) => view.setUint16(12, 2, true),
    (view) => view.setUint16(14, 12, true),
  ];
  for (const mutate of mutations) {
    const changed = dib();
    mutate(new DataView(changed.buffer));
    const source = icon([
      { bytes, width: 2, height: 2 },
      { bytes: changed, width: 2, height: 2 },
    ]);
    refuses(source);
  }
  refuses(icon([{ bytes: new Uint8Array(8), width: 2, height: 2 }]));
});
