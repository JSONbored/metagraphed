#!/usr/bin/env python3
"""Diff the Rust decoder's VERIFY output against the python ground-truth, field-by-field.
Compares only the fields the Rust emits (call_args is display-only, excluded).
Usage: diff.py truth.jsonl rust.jsonl"""
import json, sys, math

truth_p, rust_p = sys.argv[1], sys.argv[2]

# fields excluded from strict comparison (known-acceptable differences)
SKIP_BLOCK = {"author"}       # v1: author (Aura digest) is a v2 follow-up
SKIP_EXTR = {"call_args"}     # display-only JSON format differs
SKIP_EVENT = set()


def load(p):
    out = {}
    for line in open(p):
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        out[d["block"]] = d
    return out


def numclose(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if a == b:
            return True
        return abs(a - b) <= 1e-12 * max(1.0, abs(a), abs(b))
    return a == b


def cmp_rows(kind, t_rows, r_rows, key, skip, mism):
    t = {tuple(r[k] for k in key): r for r in t_rows}
    r = {tuple(rr[k] for k in key): rr for rr in r_rows}
    for k in sorted(set(t) | set(r), key=lambda x: tuple(map(str, x))):
        if k not in t:
            mism.append(f"  {kind} {k}: only in RUST")
            continue
        if k not in r:
            mism.append(f"  {kind} {k}: only in TRUTH")
            continue
        tr, rr = t[k], r[k]
        for f in sorted(set(tr) | set(rr)):
            if f in skip:
                continue
            if f not in rr:
                continue  # rust doesn't emit this field (e.g. call_args)
            tv, rv = tr.get(f), rr.get(f)
            if not numclose(tv, rv):
                mism.append(f"  {kind} {k} .{f}: truth={tv!r} rust={rv!r}")


truth, rust = load(truth_p), load(rust_p)
total_mism = 0
for bn in sorted(truth):
    if bn not in rust:
        print(f"BLOCK {bn}: MISSING in rust"); total_mism += 1; continue
    if "error" in rust[bn]:
        print(f"BLOCK {bn}: rust ERROR {rust[bn]['error'][:120]}"); total_mism += 1; continue
    tr, rr = truth[bn]["rows"], rust[bn]["rows"]
    mism = []
    cmp_rows("block", tr["blocks"], rr["blocks"], ["block_number"], SKIP_BLOCK, mism)
    cmp_rows("extr", tr["extrinsics"], rr["extrinsics"], ["block_number", "extrinsic_index"], SKIP_EXTR, mism)
    cmp_rows("event", tr["account_events"], rr["account_events"], ["block_number", "event_index"], SKIP_EVENT, mism)
    if mism:
        print(f"BLOCK {bn}: {len(mism)} mismatch(es)")
        for m in mism[:40]:
            print(m)
        total_mism += len(mism)
    else:
        print(f"BLOCK {bn}: OK (b={len(tr['blocks'])} x={len(tr['extrinsics'])} e={len(tr['account_events'])})")
print(f"\nTOTAL MISMATCHES: {total_mism}")
sys.exit(1 if total_mism else 0)
