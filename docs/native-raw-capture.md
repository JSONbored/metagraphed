# Native raw capture

`createPgRawCapture` supplies raw byte storage and per-network watermarks from
one verified PostgreSQL source. The process keeps ownership of the pool and its
shutdown; construction starts no connection, timer or capture run.

The source must be writable and own `raw_capture_budget`,
`raw_capture_batches`, `raw_capture_chunks`, `raw_capture_selected`,
`raw_capture_archives` and `raw_capture_state`. Apply and verify the existing raw
capture schema and accounting activation before selecting the capability. Its
budget row must exist; missing accounting cannot silently permit writes.

Set `RAW_CAPTURE_STORAGE=postgresql` and supply the resulting
`NATIVE_RAW_CAPTURE` binding to the existing application environment. This
selects both storage and watermark access. An incomplete or mismatched native
selection cannot fall back to D1 or Hyperdrive. The existing D1 selection keeps
its current behavior.

Both stores use the same capture input validation and deterministic gzip
encoding. Native writes acquire the schema's raw-capture advisory lock before
reading, then verify existing archive/reservation identities, insert bounded
chunks, compare their exact bytes and select the completed capture. All steps
share a read-committed transaction. A failed or uncertain commit cannot report
success; the next same-input attempt verifies the retained identity. Existing
partial captures are verified before reuse, and a failed transaction cannot
select partial bytes.

The watermark is written after byte storage succeeds. It advances monotonically
and is read back in the same transaction before acknowledgement. Mainnet and
testnet retain separate frontiers. Database read failure propagates to the
existing lane failure handling.

This prepares the capture side only. Raw-source archive consumption, complete
historical custody, source transfer, native decoder activation and production
ownership handoff require their separate acceptance. No capture tick or live
endpoint request is started by adding this module.
