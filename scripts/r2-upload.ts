// Legacy direct entry point: registry publication must never write R2 again.
throw new Error(
  "R2 registry uploads are retired. Use npm run kv:publish after the verified initial KV migration.",
);
