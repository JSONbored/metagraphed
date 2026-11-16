-- Run transactionally while external catalog writers remain fenced.
LOCK TABLE app.iceberg_catalog_namespaces, app.iceberg_catalog_tables IN ACCESS EXCLUSIVE MODE;
ALTER TABLE app.iceberg_catalog_tables
    ADD CONSTRAINT iceberg_catalog_tables_namespace_fkey
    FOREIGN KEY (namespace) REFERENCES app.iceberg_catalog_namespaces(namespace);
