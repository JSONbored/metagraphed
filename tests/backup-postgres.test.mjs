import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

function writeExecutable(filePath, content) {
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function runBackupWithMocks(pgDumpScript) {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "metagraphed-backup-test-"),
  );
  const binDirectory = path.join(temporaryDirectory, "bin");
  const uploadPath = path.join(temporaryDirectory, "uploaded.sql.gz");
  mkdirp(binDirectory);
  writeExecutable(path.join(binDirectory, "pg_dump"), pgDumpScript);
  writeExecutable(
    path.join(binDirectory, "aws"),
    `#!/usr/bin/env sh
set -eu
if [ "$1" != "s3" ] || [ "$2" != "cp" ]; then
  exit 2
fi
cat "$3" > "$FAKE_UPLOAD_PATH"
`,
  );

  const result = spawnSync("sh", ["deploy/backup/backup-postgres.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: "test-key",
      AWS_SECRET_ACCESS_KEY: "test-secret",
      DATABASE_URL: "postgres://example.invalid/metagraphed",
      FAKE_UPLOAD_PATH: uploadPath,
      PATH: `${binDirectory}:${process.env.PATH}`,
      R2_BUCKET: "metagraphed-test-backups",
      R2_ENDPOINT: "https://example.invalid",
    },
  });

  return { result, temporaryDirectory, uploadPath };
}

function mkdirp(directory) {
  mkdirSync(directory, { recursive: true });
}

test("backup script fails when pg_dump exits nonzero after partial output", () => {
  const { result, temporaryDirectory, uploadPath } = runBackupWithMocks(
    `#!/usr/bin/env sh
printf '%s\n' '-- partial dump before disconnect --'
echo 'pg_dump mock: simulated disconnect' >&2
exit 42
`,
  );

  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /backup failed: pg_dump exited nonzero/);
    assert.doesNotMatch(result.stdout, /backup complete/);
    assert.ok(readFileSync(uploadPath).length > 0);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
