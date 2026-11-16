-- Bounded exact cosine retrieval for the registry. PostgreSQL is the only
-- persistent store; this needs no vector extension or separate search service.
CREATE SCHEMA IF NOT EXISTS search;

CREATE FUNCTION search.vector_valid(value real[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT COALESCE(array_ndims(value) = 1 AND array_length(value, 1) BETWEEN 1 AND 4096
    AND NOT EXISTS (SELECT 1 FROM unnest(value) AS e WHERE e IS NULL
      OR e IN ('NaN'::real, 'Infinity'::real, '-Infinity'::real)), false)
$$;
CREATE FUNCTION search.vector_norm(value real[]) RETURNS double precision
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT sqrt(sum(e::double precision * e::double precision)) FROM unnest(value) AS e
$$;

CREATE TABLE search.indexes (
  name text COLLATE "C" PRIMARY KEY CHECK (octet_length(name) BETWEEN 1 AND 128),
  model text NOT NULL CHECK (octet_length(model) BETWEEN 1 AND 256),
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 4096),
  max_vectors integer NOT NULL CHECK (max_vectors BETWEEN 1 AND 10000),
  vector_count integer NOT NULL DEFAULT 0 CHECK (vector_count BETWEEN 0 AND max_vectors)
);
CREATE TABLE search.vectors (
  index_name text COLLATE "C" NOT NULL REFERENCES search.indexes(name),
  id text COLLATE "C" NOT NULL CHECK (octet_length(id) BETWEEN 1 AND 64),
  embedding real[] NOT NULL CHECK (search.vector_valid(embedding)),
  norm double precision GENERATED ALWAYS AS (search.vector_norm(embedding)) STORED,
  metadata text NOT NULL CHECK (octet_length(metadata) <= 10240 AND json_typeof(metadata::json) = 'object'),
  -- Extracted by the same application write that preserves metadata JSON.
  -- PostgreSQL JSON accessors reject a NUL escape even in unrelated fields.
  type_value text COLLATE "C",
  PRIMARY KEY (index_name, id)
);
CREATE INDEX vectors_type ON search.vectors(index_name, type_value, id);

CREATE FUNCTION search.preserve_index_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, search, pg_temp AS $$
BEGIN
  IF NEW.name <> OLD.name OR NEW.model <> OLD.model OR NEW.dimensions <> OLD.dimensions THEN
    RAISE EXCEPTION 'Semantic index identity and dimensions are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER vector_index_identity BEFORE UPDATE ON search.indexes
  FOR EACH ROW EXECUTE FUNCTION search.preserve_index_identity();

CREATE FUNCTION search.validate_entry() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, search, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.index_name <> OLD.index_name OR NEW.id <> OLD.id) THEN
    RAISE EXCEPTION 'Semantic vector identity is immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM search.indexes i WHERE i.name = NEW.index_name
    AND i.dimensions = array_length(NEW.embedding, 1)) THEN
    RAISE EXCEPTION 'Semantic vector dimensions differ from its index';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER vector_dimensions BEFORE INSERT OR UPDATE ON search.vectors
  FOR EACH ROW EXECUTE FUNCTION search.validate_entry();

CREATE FUNCTION search.count_entries() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, search, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE search.indexes SET vector_count = vector_count + 1 WHERE name = NEW.index_name;
  ELSE
    UPDATE search.indexes SET vector_count = vector_count - 1 WHERE name = OLD.index_name;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER vector_capacity AFTER INSERT OR DELETE ON search.vectors
  FOR EACH ROW EXECUTE FUNCTION search.count_entries();
