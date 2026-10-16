# Block feed height pagination

A head persistence retry observes older blocks after newer blocks. The recorded
`observed_at` remains the actual observation time; it is not chain order.
Fresh block-feed requests therefore order by descending block height. REST, MCP,
GraphQL and the unique-height store reader use the same versioned cursor codec.

New opaque tokens start with `bh1.`. They include nullable height, observation,
and retained source/ordinal identity. Retained rows order by height descending,
observation ascending, and source/ordinal descending. That order uses the existing
height index in reverse and preserves physically distinct duplicate rows. Unknown
heights sort last; unknown observation times sort first within a height. Internal
row identity is excluded by the public block formatter.

Previously issued two-part tokens retain observation-descending ordering and
seeking, including their original next-token format. One-part height tokens retain
height seeking and their original format. Malformed tokens retain the established
first-page behavior. Clients must continue treating tokens as opaque. Observation
filters still filter the actual observation time, independently of height ordering.

The hot and retained owners still meet at one resolved height. A new height page
fences the retained owner at that seam and binds its seek to a height upper bound;
it does not compare a hot observation time against retained observations. The
retained reader validates the same publication receipt before and after its read
and merges at most two candidate pages. Count histograms preserve an existing
selective count index when at most 50,000 active rows match. Author/spec/observation-range selectors
have an index-prefix census capped at 50,001 physical entries, including inactive
sources; a set of at most 50,000 retains its selective index and sorts that bounded
set by height. Broad selectors use the height index. The smaller proven bound wins
when selectors intersect. The extra census is itself a request read budget;
production latency, filter frequency and inactive-source membership still need
measurement. No blanket rows-read bound is claimed for arbitrary filters.

The native regression executes the real hub and SQL-backed blocks handler with
`limit=2`, live height `SEAM+1001`, repairs starting at `SEAM+15`, increasing clocks,
unchanged-head retries, revisited writes, seam crossing, duplicates and nulls. It
also verifies old tokens against the actual reader. Existing retry tests remain
unchanged. No live replay or historical timestamp fabrication is involved.

Rollback must retain a reader for `bh1` tokens while reverting unrelated behavior.
A Worker predating this codec treats those tokens as malformed and restarts at the
first page; it cannot resume them. Do not describe a rollback to that binary as
pagination-compatible. New deployments introduce no schema, binding, producer,
retention or resource changes and do not establish historical completeness.
