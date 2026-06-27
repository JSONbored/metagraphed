#!/usr/bin/env sh
# Postgres -> R2 backup (ADR 0013 durability). pg_dump the metagraphed DB, gzip,
# and stream it to R2 (S3-compatible, ZERO egress) under a timestamped key.
# Restoring a dump takes minutes; re-backfilling the same history takes weeks — so
# this is the cheap insurance against a catastrophic Postgres loss. The data is
# also re-derivable from chain, so a ~daily RPO is plenty (no PITR needed).
#
# Runs as a scheduled (cron) Railway service — see deploy/backup.railway.json.
# Env (set on that service):
#   DATABASE_URL           ${{Postgres.DATABASE_URL}}  (private net; no egress)
#   R2_BUCKET              the R2 bucket name
#   R2_ENDPOINT           https://<accountid>.r2.cloudflarestorage.com
#   AWS_ACCESS_KEY_ID     R2 S3 access key id
#   AWS_SECRET_ACCESS_KEY R2 S3 secret
#   BACKUP_PREFIX         key prefix (default: postgres)
# Retention: set an R2 lifecycle rule on the bucket (e.g. expire after 30 days) —
# that is the robust way, not a script-side prune.
set -eu

: "${DATABASE_URL:?DATABASE_URL required}"
: "${R2_BUCKET:?R2_BUCKET required}"
: "${R2_ENDPOINT:?R2_ENDPOINT required}"
PREFIX="${BACKUP_PREFIX:-postgres}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
KEY="${PREFIX}/metagraphed-${TS}.sql.gz"

echo "backup: pg_dump | gzip -> s3://${R2_BUCKET}/${KEY}"
# Stream pg_dump through gzip without landing the raw dump on container disk.
# Keep the upload as a separate step so early aws CLI/config failures cannot
# deadlock the dump/gzip FIFO chain before the script observes them.
# Use explicit process waits instead of a shell pipeline: POSIX sh reports
# only the last command's status for pipelines, which can hide pg_dump failures.
TMPDIR="$(mktemp -d)"
RAW_FIFO="${TMPDIR}/dump.sql"
GZ_FILE="${TMPDIR}/dump.sql.gz"
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT HUP INT TERM
mkfifo "$RAW_FIFO"

gzip -9 <"$RAW_FIFO" >"$GZ_FILE" &
GZIP_PID=$!
pg_dump --no-owner --no-privileges "$DATABASE_URL" >"$RAW_FIFO" &
PG_DUMP_PID=$!

STATUS=0
if ! wait "$PG_DUMP_PID"; then
  echo "backup failed: pg_dump exited nonzero" >&2
  STATUS=1
fi
if ! wait "$GZIP_PID"; then
  echo "backup failed: gzip exited nonzero" >&2
  STATUS=1
fi
if [ "$STATUS" -ne 0 ]; then
  exit "$STATUS"
fi
if ! aws s3 cp "$GZ_FILE" "s3://${R2_BUCKET}/${KEY}" --endpoint-url "$R2_ENDPOINT"; then
  echo "backup failed: aws upload exited nonzero" >&2
  exit 1
fi
echo "backup complete: s3://${R2_BUCKET}/${KEY}"
