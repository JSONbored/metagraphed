# Native live neuron view reads

`createPgNeuronViewStore(runtime, decoder)` supplies `NEURON_VIEW_STORE` to the
point and live-view data API routes. Its query contract lists columns, typed
identity filters, validator selection, ordering and an optional limit. It never
accepts caller SQL or creates a PostgreSQL stand-in for a SQLite JSON view.

One PostgreSQL statement reads the selected accepted memberships and their
current documents. The bounded, read-only codec projects each canonical member
path directly from the original SQLite JSONB. That preserves first-key behavior,
missing fields, nulls and scalar/array member values. It intentionally differs
from JSON.parse's last-key behavior and from optimized json_each readers that
retain duplicate entry multiplicity.

Ordering compares exact integers and raw text bytes before values cross the D1
wire boundary. Membership supplies netuid, UID and account keys. Hotkey filters
use indexed text equality for ordinary inputs and UTF-8 byte equality for
exceptional inputs, so a request containing NUL does not become a truncated SQL
text argument. Batches use the existing public comparison limit. The source
import's text-admissibility checks remain required; this reader does not rewrite
persisted identities.

This capability serves point neuron details, subnet validators, subnet and chain
concentration, performance/idle-stake/yield live views, and account subnet
membership. The PostgreSQL/D1 fixture drives the actual data API handlers and
compares response status and bytes. Other daily, enriched and compound SQL-view
routes retain their separate migration requirements.

Selecting this capability is explicit. Failed selected reads remain opaque
errors; an absent capability retains the existing route behavior. This module
does not activate a runtime, select a host, migrate data or change routing.
