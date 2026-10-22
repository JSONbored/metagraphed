-- Preserve the first verified settlement envelope across ambiguous replies.
-- Consumed receipts never expire: deleting one would permit payment replay.
CREATE TABLE x402_payment_attempts (
  identity_key TEXT NOT NULL PRIMARY KEY,
  request_fingerprint TEXT NOT NULL CHECK (
    length(CAST(request_fingerprint AS BLOB)) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  facilitator_url TEXT NOT NULL,
  envelope TEXT,
  payer TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'consumed')),
  receipt TEXT,
  CHECK (
    (state = 'pending' AND envelope IS NOT NULL AND receipt IS NULL)
    OR (state = 'consumed' AND envelope IS NULL AND receipt IS NOT NULL)
  )
) WITHOUT ROWID;
