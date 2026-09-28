// Preserve the existing deployment command; upload, verification and pointer
// selection now form one KV publication under the existing workflow lock.
import { publishRegistryMain } from "./registry-kv-publish.ts";

await publishRegistryMain();
