-- Load tables before attaching accounting or archive source validation. Existing
-- archives can outlive their released source batches and must load independently.
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app.raw_capture_budget (
    id bigint PRIMARY KEY CHECK (id = 1),
    bytes bigint NOT NULL DEFAULT 0 CHECK (bytes BETWEEN 0 AND 536870912),
    objects bigint NOT NULL DEFAULT 0 CHECK (objects BETWEEN 0 AND 16384)
);
CREATE TABLE app.raw_capture_batches (
    key text COLLATE "C" NOT NULL,
    sha256 text COLLATE "C" NOT NULL CHECK (length(sha256) = 64),
    network text COLLATE "C" NOT NULL CHECK (network IN ('mainnet', 'testnet')),
    first_block bigint NOT NULL CHECK (first_block >= 0),
    last_block bigint NOT NULL CHECK (last_block >= first_block),
    raw_bytes bigint NOT NULL CHECK (raw_bytes BETWEEN 1 AND 33554432),
    compressed_bytes bigint NOT NULL CHECK (compressed_bytes BETWEEN 1 AND 33619968),
    compressed_sha256 text NOT NULL CHECK (length(compressed_sha256) = 64),
    parts bigint NOT NULL CHECK (parts BETWEEN 1 AND 513),
    captured_at bigint NOT NULL CHECK (captured_at > 0),
    complete boolean NOT NULL DEFAULT false,
    PRIMARY KEY (key, sha256)
);
CREATE TABLE app.raw_capture_chunks (
    key text COLLATE "C" NOT NULL,
    sha256 text COLLATE "C" NOT NULL,
    part bigint NOT NULL CHECK (part BETWEEN 0 AND 512),
    data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 65536),
    PRIMARY KEY (key, sha256, part)
);
CREATE TABLE app.raw_capture_selected (
    key text COLLATE "C" PRIMARY KEY,
    sha256 text COLLATE "C" NOT NULL,
    network text COLLATE "C" NOT NULL CHECK (network IN ('mainnet', 'testnet')),
    last_block bigint NOT NULL,
    captured_at bigint NOT NULL
);
CREATE TABLE app.raw_capture_archives (
    key text COLLATE "C" NOT NULL,
    sha256 text COLLATE "C" NOT NULL CHECK (length(sha256) = 64),
    network text COLLATE "C" NOT NULL CHECK (network IN ('mainnet', 'testnet')),
    first_block bigint NOT NULL CHECK (first_block >= 0),
    last_block bigint NOT NULL CHECK (last_block >= first_block),
    raw_bytes bigint NOT NULL CHECK (raw_bytes BETWEEN 1 AND 33554432),
    compressed_bytes bigint NOT NULL CHECK (compressed_bytes BETWEEN 1 AND 33619968),
    compressed_sha256 text NOT NULL CHECK (length(compressed_sha256) = 64),
    parts bigint NOT NULL CHECK (parts BETWEEN 1 AND 513),
    captured_at bigint NOT NULL CHECK (captured_at > 0),
    complete boolean NOT NULL CHECK (complete),
    selected boolean NOT NULL,
    native_key text NOT NULL,
    native_etag text NOT NULL CHECK (length(native_etag) = 32),
    native_sha256 text NOT NULL CHECK (native_sha256 = compressed_sha256),
    PRIMARY KEY (key, sha256)
);
CREATE TABLE app.raw_capture_publications (
    key text COLLATE "C" NOT NULL,
    sha256 text COLLATE "C" NOT NULL CHECK (length(sha256) = 64),
    selected_sha256 text NOT NULL CHECK (length(selected_sha256) = 64),
    chain_sha256 text CHECK (chain_sha256 IS NULL OR length(chain_sha256) = 64),
    PRIMARY KEY (key, sha256)
);
CREATE TABLE app.raw_capture_state (
    network text COLLATE "C" PRIMARY KEY,
    last_contiguous_block bigint NOT NULL,
    updated_at bigint NOT NULL,
    stopped_at bigint,
    last_error text
);

CREATE INDEX raw_capture_archives_network_block ON app.raw_capture_archives (network, last_block, key) WHERE selected;
CREATE INDEX raw_capture_selected_network_block ON app.raw_capture_selected (network, last_block, key);

CREATE FUNCTION app.raw_capture_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    -- The statement boundary precedes tuple and foreign-key locks, including
    -- a first reservation or an archive whose release cascades to its chunks.
    PERFORM pg_advisory_xact_lock(1297306, 0);
    RETURN NULL;
END;
$$;

CREATE FUNCTION app.raw_capture_reserve() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
    UPDATE app.raw_capture_budget
        SET bytes = bytes + NEW.compressed_bytes, objects = objects + 1 WHERE id = 1;
    RETURN NULL;
END;
$$;
CREATE FUNCTION app.raw_capture_release() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
    UPDATE app.raw_capture_budget
        SET bytes = bytes - OLD.compressed_bytes, objects = objects - 1 WHERE id = 1;
    RETURN NULL;
END;
$$;
CREATE FUNCTION app.raw_capture_archive_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM app.raw_capture_batches b
        WHERE b.key = NEW.key AND b.sha256 = NEW.sha256 AND b.complete
            AND b.network = NEW.network AND b.first_block = NEW.first_block AND b.last_block = NEW.last_block
            AND b.raw_bytes = NEW.raw_bytes AND b.compressed_bytes = NEW.compressed_bytes
            AND b.compressed_sha256 = NEW.compressed_sha256 AND b.parts = NEW.parts AND b.captured_at = NEW.captured_at
            AND NEW.parts = (SELECT count(*) FROM app.raw_capture_chunks c WHERE c.key = b.key AND c.sha256 = b.sha256)
            AND NEW.compressed_bytes = (SELECT sum(octet_length(data)) FROM app.raw_capture_chunks c WHERE c.key = b.key AND c.sha256 = b.sha256)
            AND NEW.selected = EXISTS (SELECT 1 FROM app.raw_capture_selected s WHERE s.key = b.key AND s.sha256 = b.sha256)
    ) THEN
        RAISE EXCEPTION 'Raw archive source changed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE FUNCTION app.raw_capture_archive_release() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
    UPDATE app.raw_capture_archives SET selected = false
        WHERE key = NEW.key AND sha256 <> NEW.sha256 AND NEW.selected;
    DELETE FROM app.raw_capture_selected WHERE key = NEW.key AND sha256 = NEW.sha256;
    DELETE FROM app.raw_capture_batches WHERE key = NEW.key AND sha256 = NEW.sha256;
    RETURN NULL;
END;
$$;
