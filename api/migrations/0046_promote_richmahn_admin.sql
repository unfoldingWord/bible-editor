-- Promote richmahn from editor to admin so he can reach the new admin panel
-- (sync-status / open-PRs / user-role management). richmahn and
-- deferredreward are the only two admins going forward.
--
-- INSERT OR IGNORE + UPDATE (rather than a plain UPDATE) so this migration is
-- correct whether the 0016 seed row already exists or not.
INSERT OR IGNORE INTO user_roles (dcs_username, role) VALUES ('richmahn', 'admin');
UPDATE user_roles SET role = 'admin' WHERE dcs_username = 'richmahn';
