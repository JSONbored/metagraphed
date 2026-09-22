-- One revision per affected family transaction, not one extra write per row.
CREATE TABLE archive_export_revisions (
 table_name TEXT PRIMARY KEY NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 0)
) WITHOUT ROWID;
