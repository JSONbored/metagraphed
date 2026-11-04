# Native inference preparation

`AI_INFERENCE` explicitly selects embedding and completion operations for registry
synchronization, semantic search and grounded answers. `createNativeAiInference`
implements that capability for operator-supplied OpenAI-compatible HTTP servers.
The embedding and completion endpoints may be separate. It creates no server,
model installation, account or external subscription.

Each capability declares its embedding provider, model and dimensions, plus its
completion provider and model. Prices per million input/output tokens are
optional declarations; unknown prices remain absent. Native results and product
telemetry use these declared identities rather than the Workers AI names or
Cloudflare prices. Existing Worker inference and gateway configuration remain
the default only when no native capability is supplied. A malformed selected
capability fails instead of using a different provider.

Native semantic indexes expose their immutable name, model and dimensions.
Inference must agree with the selected index before it can run. Synchronization
manifests are scoped by index name and embedding identity, so a new index or model
cannot inherit another index's completed-document markers. A model transition
requires a separately populated index before serving ownership changes.

The HTTP adapter sends text embedding batches and non-streaming chat completions,
which are the operations used by the current application. It validates complete
embedding batch indexes/dimensions and completion/usage shapes. Model dimensions
are verified against the returned vectors, not silently truncated. URLs and
authentication headers are fixed at construction; request content cannot select
a destination. Redirects are refused, and upstream response bodies are not used
as error messages.

Request/response byte limits, output-token limits, execution/drain deadlines and
concurrency are explicit constructor options. Aggregate configured wire buffers
cannot exceed 64 MiB; JSON parsing has additional process-memory overhead. The
response reader also caps chunk counts and yields while consuming very fragmented
streams so deadline callbacks can run. Abort cancels the body reader. Work whose
transport ignores cancellation retains its admission slot until it actually
finishes; an unsuccessful drain stays observable and can be awaited again.

The process owns `close()` and must drain inference before releasing its other
resources. Request handlers receive only the inference capability. The adapter
does not alter global fetch, close a shared dispatcher or own the database pool.

This prepares the application boundary. Production still requires pinned model
weights, an accepted model-serving process, endpoint credentials where needed,
capacity and answer-quality qualification, completed embedding synchronization
and recovery/cutover verification. No production inference endpoint is selected
by this code or these tests.
