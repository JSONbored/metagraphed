// Per-extrinsic detail (#1849): the shared D1-tier extrinsic-detail loader that
// backed REST GET /extrinsics/{ref} and MCP get_extrinsic was removed in the
// D1->Postgres migration (#4772). The Worker now reads the extrinsic and its
// embedded account_events directly via Postgres, so this module no longer holds a
// loader. Retained as a placeholder for that route's history.
