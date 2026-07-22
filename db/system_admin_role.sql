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
--  This script performs the transition off the old admin/analyst/viewer
--  seed roles. It is fully idempotent and safe to re-run: the cleanup step
--  removes only BUILT-IN (is_system) roles other than System Admin, and users
--  can never create is_system roles through the app — so roles an admin has
--  created (is_system = false) are never touched.
-- =====================================================================

DO $sysadmin$
DECLARE
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

    -- 4. Drop the legacy seed roles. Only built-in roles other than System Admin are
    --    removed — custom roles (is_system = false) are left alone — so this is safe
    --    to run at any time, including after the app's own startup bootstrap has
    --    already created System Admin. Their user_roles rows cascade, which is the
    --    point: direct role assignment is no longer how access works.
    DELETE FROM roles WHERE is_system AND name <> 'System Admin';
END
$sysadmin$;
