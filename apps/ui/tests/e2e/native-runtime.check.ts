import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const serverEntry = fileURLToPath(new URL("../../dist/native/server/index.mjs", import.meta.url));
const preload = fileURLToPath(new URL("./native-runtime-preload.ts", import.meta.url));
let child: ChildProcess;
let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
let output = "";
let origin = "";
let finished = false;
const delay = (millis: number) => new Promise<void>((resolve) => setTimeout(resolve, millis));
const get = (path: string, method = "GET") =>
  fetch(`${origin}${path}`, {
    method,
    headers: { accept: "text/html" },
    signal: AbortSignal.timeout(5000),
  });

describe("built native UI", { concurrency: false }, () => {
  before(async () => {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const address = reservation.address();
    assert(address && typeof address === "object");
    origin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NITRO_HOST: "127.0.0.1",
      NITRO_PORT: String(address.port),
      SERVER_SHUTDOWN_TIMEOUT: "2",
      NODE_OPTIONS: "--max-old-space-size=1024",
    };
    delete env.CI;
    delete env.TEST;
    child = spawn(process.execPath, ["--import", preload, serverEntry], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    exit = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        finished = true;
        resolve({ code, signal });
      });
    });
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk) => {
        output += String(chunk);
        if (output.length > 65536) {
          child.kill("SIGKILL");
          output = `${output.slice(0, 65536)}\nNative fixture log budget exceeded`;
        }
      });
    for (let attempt = 0; attempt < 40; attempt++) {
      if (finished) throw new Error(`Native UI exited before readiness: ${output}`);
      try {
        if ((await get("/robots.txt")).ok) return;
      } catch {
        /* Not listening yet. */
      }
      await delay(100);
    }
    throw new Error(`Native UI did not become ready: ${output}`);
  });

  after(async () => {
    if (!child) return;
    if (!finished) child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 5000);
    });
    const stopped = await Promise.race([exit, deadline]).finally(() => clearTimeout(timer));
    process.stderr.write(output);
    if (!stopped) {
      child.kill("SIGKILL");
      await exit;
      assert.fail(`Native UI did not drain: ${output}`);
    }
    assert.equal(stopped.code, 0, output);
    assert.equal(stopped.signal, null, output);
    assert(!output.includes("Unexpected native fixture fetch"), output);
    assert(!output.includes("Native fixture log budget exceeded"), output);
  });

  it("serves SSR with the canonical head and discovery header", async () => {
    const response = await get("/about");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("link") ?? "", /api-catalog/);
    const html = await response.text();
    assert.match(html, /About.*Metagraphed/);
    assert.match(html, /max-image-preview:large/);
    assert.match(html, /property="og:locale"/);
  });

  it("serves static assets byte-for-byte and preserves HEAD", async () => {
    const expected = readFileSync(
      new URL("../../dist/native/public/logos/metagraphed.png", import.meta.url),
    );
    const response = await get("/logos/metagraphed.png");
    assert.equal(response.status, 200);
    const actual = Buffer.from(await response.arrayBuffer());
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    assert.equal(digest(actual), digest(expected));
    const head = await get("/logos/metagraphed.png", "HEAD");
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });

  it("serves backend discovery without external network access", async () => {
    const response = await get("/llms.txt");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "Native UI fixture discovery\n");
  });

  it("serves its exact fallback image during a font failure", async () => {
    const expected = readFileSync(
      new URL("../../dist/native/public/og-fallback.png", import.meta.url),
    );
    const response = await get("/og?title=Native&logop=/logos/metagraphed.png");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=60");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  });

  it("recovers to a rendered OG image with a verified local logo", async () => {
    const response = await get("/og?title=Native&logop=/logos/metagraphed.png");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.match(response.headers.get("cache-control") ?? "", /max-age=86400/);
    const png = Buffer.from(await response.arrayBuffer());
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
  });
});
