-- Adds:
--  * dcs_access_token — kept so /api/auth/logout can call DCS's RFC 7009
--    revoke endpoint, forcing the next sign-in to prompt for credentials
--    instead of silently re-issuing a token from a live DCS session.
--  * last_book / last_chapter / last_verse — per-user "where I left off" so
--    sign-in (which round-trips through DCS and loses the URL hash) lands
--    the translator back where they were instead of dumping them at the
--    default book.
ALTER TABLE users ADD COLUMN dcs_access_token TEXT;
ALTER TABLE users ADD COLUMN last_book TEXT;
ALTER TABLE users ADD COLUMN last_chapter INTEGER;
ALTER TABLE users ADD COLUMN last_verse INTEGER;
