**No linked issue — rationale**

`loadAccountExtrinsics` was the remaining account-scoped feed without the inverted `block_start > block_end` short-circuit that global `loadExtrinsics` (#2496) and `loadAccountHistory` (#2594) already have. An impossible block window should return an empty page without touching D1.

This is intentionally narrow (loader + REST handler regression tests only). It does **not** overlap with closed #2510 (event feeds) or merged #2516 (global extrinsics feed, which already short-circuits via `loadExtrinsics`).

Follow-up in 7ac9f5c1: fixed Prettier line-wrap on the handler test (was failing `checks`), rebased onto latest main, and asserted `next_cursor === null` on both loader and handler short-circuit paths.
