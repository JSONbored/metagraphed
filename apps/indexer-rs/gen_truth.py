#!/usr/bin/env python3
"""Ground-truth generator: runs the VERIFIED python decode (index-chain.rows_from_decoded
o stream-events.decode_head) on the given blocks and emits canonical JSON per block,
so the Rust port can be diffed against it byte-for-byte (semantics)."""
import importlib.util, os, json, sys

SCRIPTS = os.environ.get("SCRIPTS_DIR")
if not SCRIPTS:
    sys.exit("SCRIPTS_DIR must be set to the directory containing index-chain.py")


def load(name, fn):
    spec = importlib.util.spec_from_file_location(name, os.path.join(SCRIPTS, fn))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


ic = load("index_chain", "index-chain.py")
decode_head = ic._decode_head()
from substrateinterface import SubstrateInterface

URL = os.environ.get("RPC", "wss://archive.chain.opentensor.ai:443")


def fresh():
    s = SubstrateInterface(url=URL)
    s.init_runtime()
    return s


s = fresh()
blocks = []
for arg in sys.argv[1:]:
    blocks += [int(x) for x in arg.replace(",", " ").split()]
for bn in blocks:
    for attempt in range(4):
        try:
            rows = ic.rows_from_decoded(decode_head(s, bn))
            print(json.dumps({"block": bn, "rows": rows}, sort_keys=True, default=str), flush=True)
            break
        except Exception as e:
            if attempt == 3:
                print(json.dumps({"block": bn, "error": repr(e)[:200]}, sort_keys=True), flush=True)
            else:
                try:
                    s = fresh()  # reconnect on a dropped socket and retry the block
                except Exception:
                    pass
