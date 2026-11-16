-- Root basket capture era refresh (#13163, runtime v490; #13161, epic #13142).
--
-- The capture contract was pinned to the audited spec-454 decoder
-- (subtensor-v454-14cde641-v1); the live chain is at spec 490. A v490 capture
-- of the same basket_info observation is now accepted when its decoder names
-- a v490 revision -- the exact v490 commit pin, like the v490 SCALE decode
-- itself (the SubtensorModule.DeferredBasket* family), lands with the
-- engine's decoder. The two column pins become one era constraint so a spec
-- observed under one runtime can never wear the other era's decoder. The
-- legacy D1 and Neon receiver lanes keep their v454 pins (their DDL is
-- production-held); the sync receiver declines a v490 capture on those lanes
-- before any insert.
ALTER TABLE app.root_basket_captures
    DROP CONSTRAINT root_basket_captures_runtime_spec_version_check,
    DROP CONSTRAINT root_basket_captures_decoder_version_check,
    ADD CONSTRAINT root_basket_captures_era_check CHECK (
        (runtime_spec_version = 454 AND decoder_version = 'subtensor-v454-14cde641-v1')
        OR (runtime_spec_version = 490 AND decoder_version ~ '^subtensor-v490-[0-9a-f]{8}-v[1-9][0-9]*$')
    );
