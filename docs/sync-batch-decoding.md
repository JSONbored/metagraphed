# Bounded sync-batch decoding

The compressed and decoded budgets measure different representations. Producers
still allow 96 KiB compressed messages. Decoding counts actual expanded UTF-8
bytes before retaining a chunk; gzip trailer sizes are not trusted. The shared
decoded ceiling is **79,393,024 bytes**:

```
4 * 16,000,000 + 192 * 80,000 + 2,048 * 16 + 256
```

This is a conservative envelope for the currently admitted chain-detail HTTP
parser and its queue transformation, not a sampled block size or a production
memory-capacity claim. The admission constants live in `src/sync-batch-limits.ts`
and the parser re-exports them without changing existing imports or values.

## Source accounting

Let B be the admitted HTTP UTF-8 bytes, R its pre-deduplication detail rows and K
its blocks. `parseChainDetailSync` admits B <= 16,000,000, R <= 80,000 and K <= 16.
Deduplication only reduces output. The route passes its four exact projected row
families to `packMultiFamilyMessage`, adding only its fixed lane/timestamp
envelope. The accounting deliberately does not substitute the independent
5,000-row consumer shape check for the producer's 80,000-row admission.

- Retained string values, existing keys, punctuation and row structure cost no
  more than their source spelling, apart from numeric normalization accounted
  below. JSON escape normalization does not enlarge the UTF-8 spelling of a
  retained string, including control characters and escaped lone surrogates.
  Unknown properties are discarded; flags become 0/1; no payload string is
  replicated into another row family by this parser.
- Let A be source bytes containing decimal amount strings used by economics.
  Each is retained in its original row. Native/stake amounts can additionally
  contribute to their category total and the combined activity total. Fee, tip
  and issuance amounts contribute to one total. Thus derived digits cost at
  most 2A, plus per-block carry/scale allowances. At most 80,000 addends add five
  integer digits; the reducer uses scale 18. Those finite suffix/carry costs for
  six totals fit within the per-block allowance. Invalid amounts yield null.
- Let C be source bytes containing `call_args`. Every distinct derived netuid
  comes from a named `netuid`/longer key or the longer name/value object form.
  A named entry needs at least ten inner JSON bytes, before outer escaping. A
  finite JavaScript number serializes in at most 24 ASCII bytes; its comma costs
  one more. Charging 3C therefore bounds the derived numeric list. Repeated
  discoveries collapse in a Set. Direct account-row netuids are charged below.
- A and C are disjoint source spans, so retained source plus 2A + 3C is <= 4B.
- A detail row has at most six normalized numeric fields. Charging 24 bytes for
  each, plus 25 bytes for a directly derived netuid, is <= 192 bytes per row.
  This covers short exponent input expanding into longer integer spellings.
- Per block, 2,048 bytes covers the fixed projected block fields, normalized
  scalars, counts, clock, six economics keys/quotes and the finite decimal
  carry/scale allowances. The variable derived digits and netuid lists are
  already charged above. The fixed family/lane/timestamp envelope fits 256 bytes.

The only application compression sender is the chain-detail route. Other queue
lanes retain their existing JSON-object encoding and packing. The current
chain-detail routing exclusion is unchanged. A future transform that duplicates
payloads, changes the economics outputs or extracts a different attribution
shape must revisit this accounting and its compatibility fixtures.

## Disposal and refusal

The consumer expands, validates, writes and disposes each message before reading
the next. It retains counters/lane names, not an array of decoded payloads.
Ordinary malformed gzip/JSON keeps the existing null/ACK behavior. Expansion
refusal throws a distinct error and retries the original compressed delivery;
the existing dead-letter branch preserves its bytes before acknowledgment. No
failed business write is replayed by that branch. Neighbouring messages retain
their independent disposition.

Cancellation is requested with rejection handling and its acknowledgment is not
awaited. A rejecting or never-settling cancellation cannot block refusal. The
reader lock is released on success, stream failure and overflow. Streaming text
decoding avoids retaining expanded byte chunks and a second contiguous byte
buffer. Full-message JSON parsing and real isolate headroom remain separate
resource limits; this change does not certify production memory at the ceiling.
