-- =====================================================================
--  Access Control: user groups
--
--  Roles already answer "what can this role do?" (role_permissions) and
--  "which views/dashboards can it read?" (report_access / dashboard_access,
--  which the Access Control tab now edits from the role's side).
--
--  A GROUP is the third piece: a named bag of users that carries roles.
--  Put a user in a group and they gain every role that group holds, on top
--  of any roles assigned to them directly. Nothing is taken away — a user's
--  effective roles are the UNION of direct roles and group roles.
--
--  Idempotent: safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS user_group (
    id          SERIAL PRIMARY KEY,
    name        TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which roles a group grants.
CREATE TABLE IF NOT EXISTS user_group_role (
    group_id INT NOT NULL REFERENCES user_group(id) ON DELETE CASCADE,
    role_id  INT NOT NULL REFERENCES roles(id)      ON DELETE CASCADE,
    PRIMARY KEY (group_id, role_id)
);

-- Who is in a group.
CREATE TABLE IF NOT EXISTS user_group_member (
    group_id INT    NOT NULL REFERENCES user_group(id) ON DELETE CASCADE,
    user_id  BIGINT NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
);

-- Every request resolves a user's effective roles, so the lookup by user must be
-- indexed (the primary key above only leads with group_id).
CREATE INDEX IF NOT EXISTS ix_group_member_user ON user_group_member (user_id);

COMMENT ON TABLE user_group IS
  'A named set of users that carries roles. Effective roles = direct user_roles UNION roles of every group the user belongs to.';
