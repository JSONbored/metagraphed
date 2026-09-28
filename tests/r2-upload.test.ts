import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

test("the legacy direct uploader cannot resume R2 writes, even with old write flags", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/r2-upload.ts", "--write"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        METAGRAPH_ALLOW_R2_UPLOAD: "1",
        METAGRAPH_R2_UPLOAD_HISTORY: "1",
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /R2 registry uploads are retired/);
});
