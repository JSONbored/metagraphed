// Manual diagnostic only: exact private native bytes, encrypted before artifact retention.
import assert from "node:assert/strict";
import { createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes, constants } from "node:crypto";
import { writeFile } from "node:fs/promises";

const text = process.env.NATIVE_PARITY_ASSETS ?? "";
assert.ok(Buffer.byteLength(text) <= 4096,"Capture request exceeds scope");
const assets: { partition: string; sha256: string; bytes: number }[] = JSON.parse(text);
assert.ok(Array.isArray(assets) && assets.length > 0 && assets.length <= 8,"Capture asset count exceeds scope");
let total = 0;
const seen = new Set<string>();
for (const asset of assets) {
  assert.deepEqual(Object.keys(asset).sort(),["bytes","partition","sha256"]);
  assert.ok(/^[a-f0-9]$/.test(asset.partition));
  assert.ok(/^[a-f0-9]{64}$/.test(asset.sha256));
  assert.ok(Number.isSafeInteger(asset.bytes) && asset.bytes > 0 && asset.bytes <= 524288);
  assert.ok(!seen.has(asset.sha256));seen.add(asset.sha256);total += asset.bytes;
}
assert.ok(total <= 2*1024*1024,"Capture total exceeds scope");
const publicKey = createPublicKey(Buffer.from(process.env.NATIVE_PARITY_PUBLIC_KEY ?? "","base64"));
assert.equal(publicKey.asymmetricKeyType,"rsa");
assert.ok((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 3072);
const keySha256 = createHash("sha256").update(publicKey.export({type:"spki",format:"der"})).digest("hex");
const secret = process.env.STATE_EXPORT_SECRET;
assert.ok(secret,"Existing native export credential is unavailable");
const captured = [];
for (const asset of assets) {
  const response = await fetch("https://api.metagraph.sh/api/v1/internal/native-store-export", {
    method:"POST",redirect:"error",signal:AbortSignal.timeout(30000),
    headers:{"content-type":"application/json","accept-encoding":"identity","x-state-export-token":secret},
    body:JSON.stringify({kind:"native-store",operation:"read",...asset}),
  });
  if (response.status !== 200 || !response.body || (response.headers.get("content-encoding") ?? "identity") !== "identity") {
    await response.body?.cancel();
    throw new Error(`Pinned native capture refused HTTP ${response.status}; no retry`);
  }
  const declared = response.headers.get("content-length");
  assert.ok(declared === null || declared === String(asset.bytes),"Native response byte declaration differs");
  const reader = response.body.getReader();
  const raw = Buffer.alloc(asset.bytes);let offset=0;
  try {
    for (;;) {
      const part = await reader.read();if(part.done)break;
      assert.ok(offset+part.value.byteLength <= asset.bytes,"Native response exceeds exact budget");
      raw.set(part.value,offset);offset += part.value.byteLength;
    }
  } finally { await reader.cancel();reader.releaseLock(); }
  assert.equal(offset,asset.bytes,"Native response truncated");
  assert.equal(createHash("sha256").update(raw).digest("hex"),asset.sha256,"Native capture hash differs");
  assert.equal(response.headers.get("x-content-sha256"),asset.sha256,"Native response hash receipt differs");
  captured.push({...asset,observedAt:new Date().toISOString(),data:raw.toString("base64")});
}
const key=randomBytes(32),iv=randomBytes(12);
const aad=Buffer.from(JSON.stringify({version:1,keySha256,purpose:"metagraphed-native-parity-capture"}));
const cipher=createCipheriv("aes-256-gcm",key,iv);cipher.setAAD(aad);
const ciphertext=Buffer.concat([cipher.update(Buffer.from(JSON.stringify({version:1,assets:captured}))),cipher.final()]);
const encrypted={version:1,keySha256,aad:aad.toString("base64"),iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),wrappedKey:publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},key).toString("base64"),ciphertext:ciphertext.toString("base64")};
key.fill(0);
await writeFile("native-parity-capture.encrypted.json",JSON.stringify(encrypted));
console.log(JSON.stringify({version:1,status:"encrypted",assets:assets.length,bytes:total,keySha256}));
