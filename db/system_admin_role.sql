-- =====================================================================
--  Single permanent role: "System Admin"
--
--  Access is now shaped like this:
--    - System Admin is the ONE built-in role. It holds every permission and
--      cannot be edited, deactivated or deleted.
--    - Any other role is created by an admin and grants READ access to the
--      views/dashboards picked for it (Admin Panel -> Access Control).
--    - Roles reach users only through GROUPS. Users are never given a role
--      directly in the UI.
--
--  This script performs the one-time transition off the old
--  admin/analyst/viewer seed roles. It is idempotent, but note that the
--  "delete every other role" step only runs on the FIRST run (guarded on
--  System Admin not already existing), so re-running it will never wipe out
--  roles an admin has created since.
-- =====================================================================

DO $sysadmin$
DECLARE
    v_first_run  BOOLEAN := NOT EXISTS (SELECT 1 FROM roles WHERE name = 'System Admin');
    v_role_id    INT;
    v_group_id   INT;
BEGIN
    -- 1. The permanent role.
    INSERT INTO roles (name, description, is_system)
    VALUES ('System Admin', 'Full platform administrator. Built-in and permanent.', TRUE)
    ON CONFLICT (name) DO UPDATE SET is_system = TRUE;

    SELECT id INTO v_role_id FROM roles WHERE name = 'System Admin';

    -- It always holds every permission, including any added by later releases.
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT v_role_id, p.id FROM permissions p
    ON CONFLICT DO NOTHING;

    -- 2. The group that carries it — roles reach users only through groups.
    INSERT INTO user_group (name, description)
    VALUES ('System Administrators', 'Members hold the System Admin role.')
    ON CONFLICT (name) DO NOTHING;

    SELECT id INTO v_group_id FROM user_group WHERE name = 'System Administrators';

    INSERT INTO user_group_role (group_id, role_id)
    VALUES (v_group_id, v_role_id)
    ON CONFLICT DO NOTHING;

    -- 3. Everyone who is an administrator TODAY keeps that access, via the group.
    --    Membership is derived from the permission, not the old role name, so it
    --    still works if the roles were renamed.
    INSERT INTO user_group_member (group_id, user_id)
    SELECT v_group_id, u.id
      FROM users u
      JOIN user_roles ur       ON ur.user_id = u.id
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p       ON p.id = rp.permission_id
     WHERE p.code = 'admin:users:manage'
    ON CONFLICT DO NOTHING;

    -- Safety net: never end up with an empty administrators group. If nothing
    -- matched above (a database seeded differently), fall back to the default
    -- admin account so there is always a way back in.
    IF NOT EXISTS (SELECT 1 FROM user_group_member WHERE group_id = v_group_id) THEN
        INSERT INTO user_group_member (group_id, user_id)
        SELECT v_group_id, u.id FROM users u WHERE u.email = 'admin@example.com'
        ON CONFLICT DO NOTHING;
    END IF;

    -- 4. First run only: drop the old seed roles. Their user_roles rows cascade,
    --    which is the point — direct role assignment is no longer how access works.
    IF v_first_run THEN
        DELETE FROM roles WHERE name <> 'System Admin';
        RAISE NOTICE 'Removed legacy roles; System Admin is now the only role.';
    END IF;
END
$sysadmin$;
