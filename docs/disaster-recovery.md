# Disaster recovery

What survives the self-hosted boxes, where it lives, and exactly how to bring
each piece back. Everything below was **executed and verified on 2026-08-02**,
not written from intent — the verification commands are included so the claims
can be re-checked rather than trusted.

The self-hosted indexer and archive hosts were decommissioned. Nothing here
depends on them.

---

## 1. What exists

| Asset                                         | Location                                                 | Size                                | Verified                                          |
| --------------------------------------------- | -------------------------------------------------------- | ----------------------------------- | ------------------------------------------------- |
| Chain history (queryable)                     | R2 Data Catalog, namespace `chain`                       | 153.6 GB parquet                    | row counts vs live Postgres, 21 tables, all exact |
| Chain history (raw bytes, post-quiesce)       | `metagraphed-artifacts/chain/raw/blocks/`                | grows ~56 MB/day                    | contiguous, no gaps                               |
| Recent blocks                                 | D1 `metagraphed`, table `blocks_head`                    | ~7,200 rows/day                     | contiguous, no gaps                               |
| Postgres logical backup                       | `metagraphed-backups/indexer-postgres/`                  | 121.7 GB gz                         | see §3                                            |
| **Postgres schema** (required with the above) | `metagraphed-backups/indexer-schema/`                    | 41 KB                               | 43 tables + 9 hypertables                         |
| Registry Postgres                             | `metagraphed-backups/indexer-registry/`                  | small                               | gzip OK (git is canonical anyway)                 |
| Archive node chain data                       | restic repo, `metagraphed-backups/subtensor-archive/`    | 3.2 TiB stored / 4.006 TiB restored | 4 files restored, sha256 matched live originals   |
| Host configs                                  | `metagraphed-backups/{indexer,archive,fullnode}-config/` | small                               | gzip OK                                           |

---

## 2. Chain history — nothing to restore

The chain tables are already served from R2, so this path needs no recovery
action. `src/r2-sql.ts` queries them and `src/blocks-cold-tier.ts` routes reads
between the lakehouse and D1.

Coverage is continuous by construction, and each boundary was measured:

```
chain_events   1 ─────────────────────────► 8,759,336
chain.extrinsics ───────────────────────────► 8,759,336
raw NDJSON                    8,756,635 ──────────► advancing
blocks         0 ───────────────────────────► 8,759,336
blocks_head             8,755,245 ─────────────────► advancing
```

Re-measured 2026-08-02 (#9161). The decoder has run: `chain.extrinsics` and
`chain.account_events` now reach the same height as `chain.blocks`, so the
"captured but not queryable" range described below is closed up to 8,759,336.

**The seam is no longer a constant.** `DEFAULT_BLOCKS_SEAM` (**8,759,336**, the
measured `max(chain.blocks)` at the final top-up load) is now only a FLOOR. The
seam each request routes on is resolved as `max(floor, published watermark)`,
where the watermark is `metagraph/lakehouse/decode-watermark.json` in the
`metagraphed-artifacts` bucket, written by the private decode lane — see
`src/decode-watermark.ts`. That constant was a ceiling twice and went stale
both times: on 2026-08-03 the block list was at chain head while every block
above 8,759,336 answered with 0 extrinsics and 0 events, because the decoder
was extending the lakehouse and the Worker could not see past its own config.

Nothing about the seam needs re-measuring after a backfill any more; raising
`ICEBERG_BLOCKS_MAX` by hand is neither required nor harmful. What does need
watching is the lane that publishes, and the hourly
`src/lakehouse-seam-watchdog.ts` cron does exactly that: it alarms when nothing
publishes at all, when the watermark stops moving for 3h, when the seam trails
the raw capture by more than 2,400 blocks, or when the watermark and
`chain.blocks` disagree in either direction.

`RAW_CAPTURE_GENESIS_FLOOR` (8,756,635) is deliberately left where it is. It is
the raw lane's STARTING height, so a value below the decoded ceiling only
re-captures settled blocks — wasteful but safe — while raising it above the
decoder's input would starve the pipeline. Over-capture is recoverable;
under-capture is not.

Verify coverage at any time:

```sql
-- R2 SQL. count == max - min + 1 proves contiguity (no gaps AND no duplicates).
SELECT min(block_number) AS lo, max(block_number) AS hi, count(*) AS n FROM chain.blocks;
```

> **Raw bytes trail decode by design.** Blocks after the seam exist as raw NDJSON
> (block + events, SCALE-encoded) and in `blocks_head`. Extrinsics and events for
> that range are **captured and durable but not queryable** until the hourly
> decode lane reaches them. Capture-before-decode was deliberate: the chain serves
> recent state cheaply and old state expensively, so a missed capture is permanent
> while a missed decode is not. A backlog here is normal; a backlog that stops
> shrinking is what the seam watchdog alarms on.

---

## 3. Postgres — the dump is `--data-only`

**The dump contains no schema.** Restoring needs BOTH artifacts, and neither is
a restore on its own:

1. `indexer-schema/schema-bundle-<ts>.tar.gz` — `schema.sql` (43 tables),
   `schema-timescaledb.sql` (9 `create_hypertable` calls), `migrations/`,
   `APPLIED_MIGRATIONS.tsv`
2. `indexer-postgres/metagraphed-<ts>.sql.gz` — the data

```sh
# 1. schema first, hypertables second (create_hypertable needs the table to exist)
tar xzf schema-bundle-<ts>.tar.gz
psql -d metagraphed -f schema-bundle/schema.sql
psql -d metagraphed -f schema-bundle/schema-timescaledb.sql

# 2. then the data
gunzip -c metagraphed-<ts>.sql.gz | psql -d metagraphed
```

`pg_dump` warns about circular FK constraints on `continuous_agg`; if the data
load trips them, use `--disable-triggers` (needs superuser) or drop and re-add
the constraints around the load.

### Verifying a dump without downloading it twice

Size proves nothing. Stream it and check the gzip CRC, the `COPY` sections, and
the end marker together:

```sh
curl -sf --http1.1 -H "Authorization: Bearer $CF_TOKEN" "$OBJECT_URL" \
  | gunzip -c \
  | awk '/^COPY public\./{n++} {last=$0} END{print "copy_sections="n; print "last="last}'
```

Use `set -o pipefail`, or a corrupt stream still exits 0 because the last stage
succeeded.

> **Cloudflare's REST object API ignores `Range`.** Measured: `Range: bytes=0-99`
> streamed gigabytes. So a single-stream check of a 100 GB+ object cannot resume,
> and a dropped connection is indistinguishable from corruption. For large
> objects use the **S3 API** (`<account>.r2.cloudflarestorage.com`), which honours
> `Range`, and read in chunks with per-chunk retries.

> **The backup job prunes to `BACKUP_KEEP` (default 14).** Running it when 14
> dumps already exist silently deletes the oldest. Pass `-e BACKUP_KEEP=<n>` to
> make a run purely additive.

---

## 4. Archive node — restic

Restores the full `/data/subtensor` chain database, avoiding a ~5–6 week genesis
resync.

```sh
# credentials live in /opt/metagraphed-archive/backup/backup.env on the old host;
# `set -a` matters -- restic reads RESTIC_REPOSITORY/RESTIC_PASSWORD from the
# ENVIRONMENT, and sourcing without it fails with "Please specify repository location"
set -a; . backup.env; set +a

restic snapshots                       # expect tag subtensor-archive
restic restore <snapshot-id> --target /data
```

Verified restorable by restoring individual files and comparing checksums
against the live originals — all matched:

```sh
restic restore cad39326 --target /tmp/t \
  --include /data/subtensor/chain-data/chains/bittensor/db/full/000653.sst
sha256sum /tmp/t/data/subtensor/.../000653.sst /data/subtensor/.../000653.sst
```

> **restic matches a parent snapshot by PATH.** The seed was taken of
> `/data/subtensor`; a backup unit pointed at a different path (e.g.
> `/chain-data`) finds no parent and re-reads the entire 4 TiB every run while
> still exiting 0. If a run takes hours longer than expected, check the path
> before suspecting the network.

> Verify with `restic snapshots` / `restic stats`, **never** the unit's exit
> status — a run that produced zero snapshots has exited 0 here before.

---

## 5. Selling / sharing an archive snapshot

The restic repo is already a complete, verified, restorable copy, so a separate
tarball would duplicate ~3.2 TiB indefinitely and is a worse artifact for a
recipient (no resume, no integrity verification).

**Before granting access:** the repo currently shares
`metagraphed-backups` with the Postgres dumps and host config tarballs. Sharing
read access to that bucket as-is would expose both. Move the non-archive objects
to a separate bucket first (S3 `CopyObject` is server-side; ~20 objects), leaving
the bucket holding only `subtensor-archive/`.

A recipient then needs: bucket-scoped read-only R2 credentials, the repo
password, and §4.
